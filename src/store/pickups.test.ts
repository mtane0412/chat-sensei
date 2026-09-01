/**
 * src/store/pickups.ts(Pick up 結果ストア + Pick up パイプライン)のテスト。
 *
 * 受信した発言ごとに注目の表現の抽出ジョブを低優先度で投入し、その結果(生成中・完了・失敗・
 * キュー溢れ・Prompt API 利用不可)を発言 ID に紐づけて保持することを検証する。
 * `translations.test.ts` と同じ構成で、翻訳との違いは結果の形(語句と意味のペアの配列)のみ。
 * Prompt API・環境診断・発言の購読はすべてフェイクを注入し、実ブラウザAPIには触れない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { LowPriorityQueueOverflowError, type SessionPool } from "@/lib/ai/session-pool";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import {
  MAX_WAITING_FOR_DIAGNOSIS,
  resetPickupStoreForTests,
  startPickupPipeline,
  usePickupStore,
  warmUpPickupPipeline,
  type PickupPipelineDeps,
} from "./pickups";

/** テスト用のサンプル発言(実況チャットにありそうな「ナイスプレー」の一言) */
function createMessage(overrides: Partial<TwitchChatMessage> = {}): TwitchChatMessage {
  return {
    id: "msg-1",
    channel: "example",
    userId: "1234",
    username: "viewer_taro",
    displayName: "viewer_taro",
    color: null,
    text: "gg chat",
    isAction: false,
    emotes: [],
    badges: [],
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 「gg chat」に対する抽出結果(gg を略語として拾った想定)*/
const 抽出結果 = { terms: [{ term: "gg", meaning: "good game の略、お疲れ" }] };
/** 該当する表現が無い発言の抽出結果 */
const 抽出なし = { terms: [] };

/** Prompt API が利用可能/不可能な環境診断結果 */
function createDiagnosis(overallReady: boolean): EnvironmentDiagnosis {
  return {
    chromeVersion: 150,
    meetsMinimumChromeVersion: true,
    languageModel: overallReady
      ? { supported: true, availability: "available" }
      : { supported: false, availability: null },
    languageDetector: { supported: false, availability: null },
    storageEstimate: { quota: null, usage: null },
    overallReady,
  };
}

/** Deferred パターン: テストから任意のタイミングで resolve/reject できる Promise */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * テスト用の依存性一式を組み立てる。
 * - `emit(message)` で発言受信を模擬する
 * - `pool.enqueue` は run にフェイクセッションを渡し、prompt の結果は `promptResults` から順に取り出す
 */
function createDeps(options: { ready?: boolean; promptResults?: Array<Promise<string>> } = {}) {
  const listeners = new Set<(message: TwitchChatMessage) => void>();
  let messages: TwitchChatMessage[] = [];
  const promptResults = [...(options.promptResults ?? [])];

  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    const next = promptResults.shift();
    if (!next) throw new Error("テストの promptResults が不足しています");
    return run({ prompt: () => next });
  });
  const warmUp = vi.fn(async () => {});
  const pool = { enqueue, warmUp } as unknown as SessionPool;

  const deps: PickupPipelineDeps = {
    diagnose: vi.fn(async () => createDiagnosis(options.ready ?? true)),
    loadSettings: () => ({ targetLang: "en", explainLang: "ja" }),
    createPool: vi.fn(() => pool),
    subscribeToChatMessages: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMessages: () => messages,
  };

  function emit(message: TwitchChatMessage) {
    messages = [...messages, message];
    listeners.forEach((listener) => listener(message));
  }

  function setMessages(next: TwitchChatMessage[]) {
    messages = next;
  }

  return { deps, emit, setMessages, enqueue, warmUp, listeners };
}

/** 非同期の状態更新(診断 → 投入 → 完了)が落ち着くまでマイクロタスクをフラッシュする */
async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetPickupStoreForTests();
});

describe("startPickupPipeline", () => {
  it("開始直後は Prompt API の状態が checking で、診断が成功すると ready になる", async () => {
    const { deps } = createDeps({ ready: true });

    const stop = startPickupPipeline(deps);
    expect(usePickupStore.getState().promptApi).toEqual({ status: "checking" });

    await flush();
    expect(usePickupStore.getState().promptApi).toEqual({ status: "ready" });
    stop();
  });

  it("診断で Prompt API が使えない場合は理由付きで unavailable にし、抽出ジョブは投入しない", async () => {
    const { deps, emit, enqueue } = createDeps({ ready: false });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    const { promptApi, entries } = usePickupStore.getState();
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/Prompt API/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(entries["msg-1"]).toEqual({ status: "unavailable" });
    stop();
  });

  it("受信した発言を low 優先度で抽出ジョブに積み、完了したら発言 ID に紐づけて語句と意味のペアを保持する", async () => {
    const { deps, emit, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(抽出結果))],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "gg chat" }));
    await flush();

    expect(enqueue).toHaveBeenCalledWith("low", expect.any(Function), expect.any(AbortSignal));
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: 抽出結果.terms,
    });
    stop();
  });

  it("emote だけの発言は LLM を呼ばずに terms が空の done として保持する(issue #26)", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "Kappa", emotes: [{ id: "25", start: 0, end: 4 }] }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("表示中の発言者名(username / displayName)を除外名として渡し、モデルが返しても結果から落とす(issue #26)", async () => {
    const { deps, emit, setMessages } = createDeps({
      promptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              { term: "space_toilet_master", meaning: "配信の常連" },
              { term: "gg", meaning: "good game の略" },
            ],
          }),
        ),
      ],
    });
    const stop = startPickupPipeline(deps);
    await flush();
    const 常連の発言 = createMessage({ id: "msg-0", username: "space_toilet_master", displayName: "Space_Toilet_Master" });
    const 歓迎の発言 = createMessage({ id: "msg-1", text: "Welcome back space_toilet_master! gg" });
    setMessages([常連の発言, 歓迎の発言]);
    emit(歓迎の発言);
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "gg", meaning: "good game の略" }],
    });
    stop();
  });

  it("抽出ジョブが完了するまでは pending として保持する", async () => {
    const deferred = createDeferred<string>();
    const { deps, emit } = createDeps({ promptResults: [deferred.promise] });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    deferred.resolve(JSON.stringify(抽出なし));
    await flush();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("抽出ジョブが失敗した場合は理由付きで failed として保持する(暗黙のフォールバックはしない)", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.reject(new Error("モデルがクラッシュしました"))] });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "failed",
      reason: "モデルがクラッシュしました",
    });
    stop();
  });

  it("低優先度キューの上限で破棄されたジョブは dropped(未抽出)として保持する", async () => {
    const { deps, emit } = createDeps({
      promptResults: [Promise.reject(new LowPriorityQueueOverflowError())],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "dropped" });
    stop();
  });

  it("診断が終わる前に受信した発言は保留し、診断が ready になった時点でまとめて投入する", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(抽出なし))],
    });
    deps.diagnose = () => diagnosis.promise;

    const stop = startPickupPipeline(deps);
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("ID を持たない発言は抽出結果を紐づけられないため投入しない", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: null }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries).toEqual({});
    stop();
  });

  it("表示用リングバッファから消えた発言の抽出結果は、次の発言受信時に破棄する", async () => {
    const { deps, emit, setMessages } = createDeps({
      promptResults: [
        Promise.resolve(JSON.stringify(抽出なし)),
        Promise.resolve(JSON.stringify(抽出結果)),
      ],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(usePickupStore.getState().entries["msg-1"]).toBeDefined();

    // msg-1 がリングバッファから溢れた状態で msg-2 を受信する
    setMessages([]);
    emit(createMessage({ id: "msg-2" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toBeUndefined();
    expect(usePickupStore.getState().entries["msg-2"]).toEqual({ status: "done", terms: 抽出結果.terms });
    stop();
  });

  it("リングバッファから消えた発言が無い場合、受信時の破棄処理ではストアを更新しない(不要な再レンダーを起こさない)", async () => {
    const deferred = createDeferred<string>();
    const { deps, emit } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(抽出なし)), deferred.promise],
    });
    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    let updates = 0;
    const unsubscribe = usePickupStore.subscribe(() => {
      updates += 1;
    });
    // msg-1 はリングバッファに残ったままなので、破棄処理による更新は起きず pending の1回だけになる
    emit(createMessage({ id: "msg-2" }));
    await flush();
    unsubscribe();

    expect(updates).toBe(1);
    expect(usePickupStore.getState().entries["msg-2"]).toEqual({ status: "pending" });
    stop();
  });

  it("設定の言語ペアでセッションプールを生成する", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.resolve(JSON.stringify(抽出なし))] });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage());
    await flush();

    expect(deps.createPool).toHaveBeenCalledWith({ targetLang: "en", explainLang: "ja" });
    stop();
  });

  it("停止すると発言の購読を解除し、以後の発言では抽出ジョブを投入しない", async () => {
    const { deps, emit, enqueue, listeners } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    stop();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(listeners.size).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("診断待ちの保留は上限を超えると古いものから dropped(未抽出)にする", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, enqueue } = createDeps({
      promptResults: Array.from({ length: MAX_WAITING_FOR_DIAGNOSIS }, () =>
        Promise.resolve(JSON.stringify(抽出なし)),
      ),
    });
    deps.diagnose = () => diagnosis.promise;

    const stop = startPickupPipeline(deps);
    for (let i = 0; i < MAX_WAITING_FOR_DIAGNOSIS + 1; i++) {
      emit(createMessage({ id: `msg-${i}` }));
    }
    await flush();
    expect(usePickupStore.getState().entries["msg-0"]).toEqual({ status: "dropped" });
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(MAX_WAITING_FOR_DIAGNOSIS);
    expect(usePickupStore.getState().entries["msg-0"]).toEqual({ status: "dropped" });
    stop();
  });

  it("診断待ちの間にリングバッファから消えた発言は、診断完了後に投入しない", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, setMessages, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(抽出なし))],
    });
    deps.diagnose = () => diagnosis.promise;

    const stop = startPickupPipeline(deps);
    emit(createMessage({ id: "msg-1" }));
    setMessages([]);
    emit(createMessage({ id: "msg-2" }));
    await flush();

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(usePickupStore.getState().entries["msg-1"]).toBeUndefined();
    expect(usePickupStore.getState().entries["msg-2"]).toEqual({ status: "done", terms: [] });
    stop();
  });
});

describe("warmUpPickupPipeline", () => {
  it("診断が ready のとき、ユーザー操作の延長でセッションプールを生成しベースセッションをウォームアップする", async () => {
    const { deps, warmUp } = createDeps({ ready: true });

    const stop = startPickupPipeline(deps);
    await flush();
    warmUpPickupPipeline();
    await flush();

    expect(deps.createPool).toHaveBeenCalledWith({ targetLang: "en", explainLang: "ja" });
    expect(warmUp).toHaveBeenCalledTimes(1);
    stop();
  });

  it("診断が終わる前に呼ばれた場合は、診断が ready になった時点でウォームアップする", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, warmUp } = createDeps();
    deps.diagnose = () => diagnosis.promise;

    const stop = startPickupPipeline(deps);
    warmUpPickupPipeline();
    await flush();
    expect(warmUp).not.toHaveBeenCalled();

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(warmUp).toHaveBeenCalledTimes(1);
    stop();
  });

  it("Prompt API が利用できない場合はウォームアップしない", async () => {
    const { deps, warmUp } = createDeps({ ready: false });

    const stop = startPickupPipeline(deps);
    await flush();
    warmUpPickupPipeline();
    await flush();

    expect(warmUp).not.toHaveBeenCalled();
    stop();
  });

  it("ウォームアップに失敗した場合は Prompt API を unavailable にして理由を保持する", async () => {
    const { deps, warmUp } = createDeps({ ready: true });
    warmUp.mockRejectedValueOnce(new Error("NotAllowedError: user activation is required"));

    const stop = startPickupPipeline(deps);
    await flush();
    warmUpPickupPipeline();
    await flush();

    const { promptApi } = usePickupStore.getState();
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/user activation/);
    stop();
  });

  it("パイプラインが開始されていない状態で呼んでも何もしない", () => {
    expect(() => warmUpPickupPipeline()).not.toThrow();
  });
});
