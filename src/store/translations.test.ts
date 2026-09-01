/**
 * src/store/translations.ts(翻訳結果ストア + 翻訳パイプライン)のテスト。
 *
 * 受信した発言ごとに翻訳ジョブを低優先度で投入し、その結果(生成中・完了・失敗・
 * キュー溢れ・Prompt API 利用不可)を発言 ID に紐づけて保持することを検証する。
 * Prompt API・環境診断・発言の購読はすべてフェイクを注入し、実ブラウザAPIには触れない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { LowPriorityQueueOverflowError, type SessionPool } from "@/lib/ai/session-pool";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import {
  resetTranslationStoreForTests,
  startTranslationPipeline,
  useTranslationStore,
  type TranslationPipelineDeps,
} from "./translations";

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
  const pool = { enqueue } as unknown as SessionPool;

  const deps: TranslationPipelineDeps = {
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

  return { deps, emit, setMessages, enqueue, listeners };
}

/** 非同期の状態更新(診断 → 投入 → 完了)が落ち着くまでマイクロタスクをフラッシュする */
async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetTranslationStoreForTests();
});

describe("startTranslationPipeline", () => {
  it("開始直後は Prompt API の状態が checking で、診断が成功すると ready になる", async () => {
    const { deps } = createDeps({ ready: true });

    const stop = startTranslationPipeline(deps);
    expect(useTranslationStore.getState().promptApi).toEqual({ status: "checking" });

    await flush();
    expect(useTranslationStore.getState().promptApi).toEqual({ status: "ready" });
    stop();
  });

  it("診断で Prompt API が使えない場合は理由付きで unavailable にし、翻訳ジョブは投入しない", async () => {
    const { deps, emit, enqueue } = createDeps({ ready: false });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    const { promptApi, entries } = useTranslationStore.getState();
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/Prompt API/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(entries["msg-1"]).toEqual({ status: "unavailable" });
    stop();
  });

  it("受信した発言を low 優先度で翻訳ジョブに積み、完了したら発言 ID に紐づけて訳文を保持する", async () => {
    const { deps, emit, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify({ translation: "ナイスプレー、チャット" }))],
    });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "gg chat" }));
    await flush();

    expect(enqueue).toHaveBeenCalledWith("low", expect.any(Function), expect.any(AbortSignal));
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      translation: "ナイスプレー、チャット",
    });
    stop();
  });

  it("翻訳ジョブが完了するまでは pending として保持する", async () => {
    const deferred = createDeferred<string>();
    const { deps, emit } = createDeps({ promptResults: [deferred.promise] });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    deferred.resolve(JSON.stringify({ translation: "訳文" }));
    await flush();
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({ status: "done", translation: "訳文" });
    stop();
  });

  it("翻訳ジョブが失敗した場合は理由付きで failed として保持する(暗黙のフォールバックはしない)", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.reject(new Error("モデルがクラッシュしました"))] });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({
      status: "failed",
      reason: "モデルがクラッシュしました",
    });
    stop();
  });

  it("低優先度キューの上限で破棄されたジョブは dropped(未翻訳)として保持する", async () => {
    const { deps, emit } = createDeps({
      promptResults: [Promise.reject(new LowPriorityQueueOverflowError())],
    });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({ status: "dropped" });
    stop();
  });

  it("診断が終わる前に受信した発言は保留し、診断が ready になった時点でまとめて投入する", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify({ translation: "訳文" }))],
    });
    deps.diagnose = () => diagnosis.promise;

    const stop = startTranslationPipeline(deps);
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({ status: "done", translation: "訳文" });
    stop();
  });

  it("ID を持たない発言は翻訳結果を紐づけられないため投入しない", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: null }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useTranslationStore.getState().entries).toEqual({});
    stop();
  });

  it("表示用リングバッファから消えた発言の翻訳結果は、次の発言受信時に破棄する", async () => {
    const { deps, emit, setMessages } = createDeps({
      promptResults: [
        Promise.resolve(JSON.stringify({ translation: "1件目" })),
        Promise.resolve(JSON.stringify({ translation: "2件目" })),
      ],
    });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(useTranslationStore.getState().entries["msg-1"]).toBeDefined();

    // msg-1 がリングバッファから溢れた状態で msg-2 を受信する
    setMessages([]);
    emit(createMessage({ id: "msg-2" }));
    await flush();

    expect(useTranslationStore.getState().entries["msg-1"]).toBeUndefined();
    expect(useTranslationStore.getState().entries["msg-2"]).toEqual({ status: "done", translation: "2件目" });
    stop();
  });

  it("設定の言語ペアでセッションプールを生成する", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.resolve(JSON.stringify({ translation: "t" }))] });

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage());
    await flush();

    expect(deps.createPool).toHaveBeenCalledWith({ targetLang: "en", explainLang: "ja" });
    stop();
  });

  it("停止すると発言の購読を解除し、以後の発言では翻訳ジョブを投入しない", async () => {
    const { deps, emit, enqueue, listeners } = createDeps();

    const stop = startTranslationPipeline(deps);
    await flush();
    stop();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(listeners.size).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
