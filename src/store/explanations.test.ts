/**
 * src/store/explanations.ts(解説結果ストア + 解説パイプライン)のテスト。
 *
 * 翻訳列と異なり解説は全発言に対して生成せず、利用者が `requestExplanation` で
 * 明示的に要求した発言だけを高優先度ジョブとして投入する。その結果(生成中・完了・
 * 失敗・Prompt API 利用不可)を発言 ID に紐づけて保持することを検証する。
 * Prompt API・環境診断はすべてフェイクを注入し、実ブラウザAPIには触れない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import type { ExplanationResult } from "@/lib/ai/schemas";
import type { SessionPool } from "@/lib/ai/session-pool";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import {
  requestExplanation,
  resetExplanationStoreForTests,
  startExplanationPipeline,
  useExplanationStore,
  type ExplanationPipelineDeps,
} from "./explanations";

/** テスト用のサンプル発言(実況チャットにありそうな「ナイスゲーム」の一言) */
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

/** テスト用の解説結果(「gg」をスラングとして解説した想定) */
const サンプル解説: ExplanationResult = {
  translation: "ナイスゲーム、チャットのみんな",
  literal: "良いゲーム、チャット",
  items: [{ term: "gg", kind: "abbreviation", meaning: "good game の略", note: "試合終了時の定番の挨拶" }],
  difficulty: 2,
};

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
 * `pool.enqueue` は run にフェイクセッションを渡し、prompt の結果は `promptResults` から順に取り出す
 */
function createDeps(options: { ready?: boolean; promptResults?: Array<Promise<string>> } = {}) {
  let messages: TwitchChatMessage[] = [];
  const promptResults = [...(options.promptResults ?? [])];

  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    const next = promptResults.shift();
    if (!next) throw new Error("テストの promptResults が不足しています");
    return run({ prompt: () => next });
  });
  const pool = { enqueue, warmUp: vi.fn(async () => {}) } as unknown as SessionPool;

  const deps: ExplanationPipelineDeps = {
    diagnose: vi.fn(async () => createDiagnosis(options.ready ?? true)),
    loadSettings: () => ({ targetLang: "en", explainLang: "ja" }),
    createPool: vi.fn(() => pool),
    getMessages: () => messages,
  };

  function setMessages(next: TwitchChatMessage[]) {
    messages = next;
  }

  return { deps, setMessages, enqueue };
}

/** 非同期の状態更新(診断 → 投入 → 完了)が落ち着くまでマイクロタスクをフラッシュする */
async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetExplanationStoreForTests();
});

describe("startExplanationPipeline", () => {
  it("開始直後は Prompt API の状態が checking で、診断が成功すると ready になる", async () => {
    const { deps } = createDeps({ ready: true });

    startExplanationPipeline(deps);
    expect(useExplanationStore.getState().promptApi).toEqual({ status: "checking" });

    await flush();
    expect(useExplanationStore.getState().promptApi).toEqual({ status: "ready" });
  });

  it("診断で Prompt API が使えない場合は理由付きで unavailable にする", async () => {
    const { deps } = createDeps({ ready: false });

    startExplanationPipeline(deps);
    await flush();

    const promptApi = useExplanationStore.getState().promptApi;
    expect(promptApi.status).toBe("unavailable");
    if (promptApi.status === "unavailable") expect(promptApi.reason).toContain("Prompt API");
  });

  it("診断そのものが失敗した場合も理由付きで unavailable にする", async () => {
    const { deps } = createDeps();
    deps.diagnose = vi.fn(async () => {
      throw new Error("navigator が見つかりません");
    });

    startExplanationPipeline(deps);
    await flush();

    expect(useExplanationStore.getState().promptApi).toEqual({
      status: "unavailable",
      reason: "環境診断に失敗しました: navigator が見つかりません",
    });
  });
});

describe("requestExplanation", () => {
  it("要求した発言を high 優先度で解説ジョブに積み、完了したら発言 ID に紐づけて結果を保持する", async () => {
    const { deps, setMessages, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(サンプル解説))],
    });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toBe("high");
    expect(useExplanationStore.getState().entries["msg-1"]).toEqual({ status: "done", result: サンプル解説 });
  });

  it("解説ジョブが完了するまでは pending として保持する", async () => {
    const deferred = createDeferred<string>();
    const { deps, setMessages } = createDeps({ promptResults: [deferred.promise] });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();

    expect(useExplanationStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    deferred.resolve(JSON.stringify(サンプル解説));
    await flush();
    expect(useExplanationStore.getState().entries["msg-1"]?.status).toBe("done");
  });

  it("解説ジョブが失敗した場合は理由付きで failed として保持する(暗黙のフォールバックはしない)", async () => {
    const { deps, setMessages } = createDeps({ promptResults: [Promise.resolve("これはJSONではない")] });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();

    const entry = useExplanationStore.getState().entries["msg-1"];
    expect(entry?.status).toBe("failed");
    if (entry?.status === "failed") expect(entry.reason).toContain("JSONとして解釈できませんでした");
  });

  it("生成中の発言を再度要求しても二重には投入しない", async () => {
    const deferred = createDeferred<string>();
    const { deps, setMessages, enqueue } = createDeps({ promptResults: [deferred.promise] });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    requestExplanation(message);
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("完了済みの発言を再度要求しても再生成しない", async () => {
    const { deps, setMessages, enqueue } = createDeps({
      promptResults: [Promise.resolve(JSON.stringify(サンプル解説))],
    });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();
    requestExplanation(message);
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("失敗した発言を再度要求すると再試行する", async () => {
    const { deps, setMessages, enqueue } = createDeps({
      promptResults: [Promise.resolve("壊れた応答"), Promise.resolve(JSON.stringify(サンプル解説))],
    });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();
    expect(useExplanationStore.getState().entries["msg-1"]?.status).toBe("failed");

    requestExplanation(message);
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(useExplanationStore.getState().entries["msg-1"]?.status).toBe("done");
  });

  it("生成中に別の発言を要求した場合は前のジョブを中断せず、順に積んで両方の結果を保持する", async () => {
    const first = createDeferred<string>();
    const second = createDeferred<string>();
    const { deps, setMessages, enqueue } = createDeps({ promptResults: [first.promise, second.promise] });
    const message1 = createMessage({ id: "msg-1" });
    const message2 = createMessage({ id: "msg-2", text: "this is so real" });
    setMessages([message1, message2]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message1);
    requestExplanation(message2);
    await flush();

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(useExplanationStore.getState().entries["msg-1"]).toEqual({ status: "pending" });
    expect(useExplanationStore.getState().entries["msg-2"]).toEqual({ status: "pending" });

    first.resolve(JSON.stringify(サンプル解説));
    second.resolve(JSON.stringify({ ...サンプル解説, translation: "これはマジでそう" }));
    await flush();

    expect(useExplanationStore.getState().entries["msg-1"]?.status).toBe("done");
    expect(useExplanationStore.getState().entries["msg-2"]?.status).toBe("done");
  });

  it("Prompt API が利用できない環境で要求した発言は unavailable として保持し、ジョブは投入しない", async () => {
    const { deps, setMessages, enqueue } = createDeps({ ready: false });
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message);
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useExplanationStore.getState().entries["msg-1"]).toEqual({ status: "unavailable" });
  });

  it("診断が終わる前に要求した発言も unavailable として保持し、ジョブは投入しない", async () => {
    const { deps, setMessages, enqueue } = createDeps();
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    startExplanationPipeline(deps);

    requestExplanation(message);

    expect(enqueue).not.toHaveBeenCalled();
    expect(useExplanationStore.getState().entries["msg-1"]).toEqual({ status: "unavailable" });
  });

  it("ID を持たない発言は解説結果を紐づけられないため投入しない", async () => {
    const { deps, enqueue } = createDeps();
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(createMessage({ id: null }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useExplanationStore.getState().entries).toEqual({});
  });

  it("表示用リングバッファから消えた発言の解説結果は、次の要求時に破棄する", async () => {
    const { deps, setMessages } = createDeps({
      promptResults: [
        Promise.resolve(JSON.stringify(サンプル解説)),
        Promise.resolve(JSON.stringify(サンプル解説)),
      ],
    });
    const message1 = createMessage({ id: "msg-1" });
    const message2 = createMessage({ id: "msg-2" });
    setMessages([message1, message2]);
    startExplanationPipeline(deps);
    await flush();

    requestExplanation(message1);
    await flush();
    expect(useExplanationStore.getState().entries["msg-1"]?.status).toBe("done");

    // リングバッファから msg-1 が押し出された後に msg-2 を要求する
    setMessages([message2]);
    requestExplanation(message2);
    await flush();

    expect(useExplanationStore.getState().entries["msg-1"]).toBeUndefined();
    expect(useExplanationStore.getState().entries["msg-2"]?.status).toBe("done");
  });

  it("設定の言語ペアでセッションプールを、最初の要求時に一度だけ生成する", async () => {
    const { deps, setMessages } = createDeps({
      promptResults: [
        Promise.resolve(JSON.stringify(サンプル解説)),
        Promise.resolve(JSON.stringify(サンプル解説)),
      ],
    });
    const message1 = createMessage({ id: "msg-1" });
    const message2 = createMessage({ id: "msg-2" });
    setMessages([message1, message2]);
    startExplanationPipeline(deps);
    await flush();
    expect(deps.createPool).not.toHaveBeenCalled();

    requestExplanation(message1);
    requestExplanation(message2);
    await flush();

    expect(deps.createPool).toHaveBeenCalledTimes(1);
    expect(deps.createPool).toHaveBeenCalledWith({ targetLang: "en", explainLang: "ja" });
  });

  it("停止後に要求してもジョブを投入しない", async () => {
    const { deps, setMessages, enqueue } = createDeps();
    const message = createMessage({ id: "msg-1" });
    setMessages([message]);
    const stop = startExplanationPipeline(deps);
    await flush();

    stop();
    requestExplanation(message);
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
  });

  it("パイプラインが開始されていない状態で要求しても何もしない", () => {
    requestExplanation(createMessage({ id: "msg-1" }));

    expect(useExplanationStore.getState().entries).toEqual({});
  });
});
