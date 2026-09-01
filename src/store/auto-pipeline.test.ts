/**
 * src/store/auto-pipeline.ts(受信した発言を自動で LLM ジョブに流す共通パイプラインのファクトリ)のテスト。
 *
 * 翻訳列・Pick up 列に共通する振る舞い ―― 受信した発言ごとに Language Detector で言語を判定し、
 * 学ぶ言語ならその言語のセッションプールへジョブを低優先度で投入し、その結果
 * (生成中・完了・失敗・キュー溢れ・Prompt API 利用不可・同じ言語・対象外の言語)を発言 ID に紐づけて保持すること、
 * 環境診断が終わるまで発言を保留すること、ウォームアップ、リングバッファから消えた発言の破棄 ――
 * をここで検証する。翻訳・Pick up 固有の振る舞いは `translations.test.ts` / `pickups.test.ts` が担当する。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { LowPriorityQueueOverflowError } from "@/lib/ai/session-pool";
import { createAutoPipeline, MAX_WAITING_FOR_DIAGNOSIS } from "./auto-pipeline";
import { createDeferred, createDeps, createDiagnosis, createMessage, flush } from "./pipeline-test-fixtures";
import { resetPromptApiStoreForTests, usePromptApiStore } from "./prompt-api";

/** テスト用の結果の形。モデルの応答文字列をそのまま保持する */
interface EchoResult {
  result: string;
}

/**
 * テスト用のパイプライン。発言本文をそのままモデルに渡し、応答文字列を `result` として保持する。
 * `resolveWithoutModel` は「skip:」で始まる発言だけをモデルを呼ばずに確定させる。
 */
const pipeline = createAutoPipeline<EchoResult>({
  createBaseSession: () => async () => {
    throw new Error("テストでは createPool を注入するため呼ばれない");
  },
  resolveWithoutModel: (message) => (message.text.startsWith("skip:") ? { result: message.text } : null),
  runJob: async (pool, message, { signal }) => {
    const raw = await pool.enqueue("low", (session) => session.prompt(message.text), signal);
    return { result: raw };
  },
});

const { useStore, start, warmUp: warmUpPipeline } = pipeline;

afterEach(() => {
  pipeline.resetForTests();
  resetPromptApiStoreForTests();
});

describe("createAutoPipeline().start", () => {
  it("開始直後は共有の Prompt API 状態が checking で、診断が成功すると ready になる", async () => {
    const { deps } = createDeps({ ready: true });

    const stop = start(deps);
    expect(usePromptApiStore.getState().status).toEqual({ status: "checking" });

    await flush();
    expect(usePromptApiStore.getState().status).toEqual({ status: "ready" });
    stop();
  });

  it("診断で Prompt API が使えない場合は理由付きで unavailable にし、ジョブは投入しない", async () => {
    const { deps, emit, enqueue } = createDeps({ ready: false });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    const promptApi = usePromptApiStore.getState().status;
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/Prompt API/);
    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "unavailable" });
    stop();
  });

  it("受信した発言を runJob に渡し、完了したら発言 ID に紐づけて done として保持する", async () => {
    const { deps, emit, enqueue } = createDeps({ promptResults: [Promise.resolve("ナイスプレー、チャット")] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "gg chat" }));
    await flush();

    expect(enqueue).toHaveBeenCalledWith("low", expect.any(Function), expect.any(AbortSignal));
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "done", result: "ナイスプレー、チャット" });
    stop();
  });

  it("resolveWithoutModel が結果を返した発言はモデルを呼ばず、その結果で done にする", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "skip: そのまま" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "done", result: "skip: そのまま" });
    stop();
  });

  it("ジョブが完了するまでは pending として保持する", async () => {
    const deferred = createDeferred<string>();
    const { deps, emit } = createDeps({ promptResults: [deferred.promise] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    deferred.resolve("結果");
    await flush();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "done", result: "結果" });
    stop();
  });

  it("ジョブが失敗した場合は理由付きで failed として保持する(暗黙のフォールバックはしない)", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.reject(new Error("モデルがクラッシュしました"))] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "failed", reason: "モデルがクラッシュしました" });
    stop();
  });

  it("低優先度キューの上限で破棄されたジョブは dropped として保持する", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.reject(new LowPriorityQueueOverflowError())] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "dropped" });
    stop();
  });

  it("診断が終わる前に受信した発言は保留し、診断が ready になった時点でまとめて投入する", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, enqueue } = createDeps({ promptResults: [Promise.resolve("結果")] });
    deps.diagnose = () => diagnosis.promise;

    const stop = start(deps);
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "done", result: "結果" });
    stop();
  });

  it("ID を持たない発言は結果を紐づけられないため投入しない", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: null }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries).toEqual({});
    stop();
  });

  it("表示用リングバッファから消えた発言の結果は、次の発言受信時に破棄する", async () => {
    const { deps, emit, setMessages } = createDeps({
      promptResults: [Promise.resolve("1件目"), Promise.resolve("2件目")],
    });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();
    expect(useStore.getState().entries["msg-1"]).toBeDefined();

    // msg-1 がリングバッファから溢れた状態で msg-2 を受信する
    setMessages([]);
    emit(createMessage({ id: "msg-2" }));
    await flush();

    expect(useStore.getState().entries["msg-1"]).toBeUndefined();
    expect(useStore.getState().entries["msg-2"]).toEqual({ status: "done", result: "2件目" });
    stop();
  });

  it("リングバッファから消えた発言が無い場合、受信時の破棄処理ではストアを更新しない(不要な再レンダーを起こさない)", async () => {
    const deferred = createDeferred<string>();
    const { deps, emit } = createDeps({ promptResults: [Promise.resolve("1件目"), deferred.promise] });
    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    let updates = 0;
    const unsubscribe = useStore.subscribe(() => {
      updates += 1;
    });
    // msg-1 はリングバッファに残ったままなので、破棄処理による更新は起きず pending の1回だけになる
    emit(createMessage({ id: "msg-2" }));
    await flush();
    unsubscribe();

    expect(updates).toBe(1);
    expect(useStore.getState().entries["msg-2"]).toEqual({ status: "pending" });
    stop();
  });

  it("判定した学ぶ言語と解説言語のペアでセッションプールを生成する", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.resolve("t")] });

    const stop = start(deps);
    await flush();
    emit(createMessage());
    await flush();

    expect(deps.createPool).toHaveBeenCalledWith("en", "ja");
    stop();
  });

  it("言語判定には emote を取り除いた本文を渡す(emote 名で判定が英語に寄らないようにする)", async () => {
    const { deps, emit, detect } = createDeps({ promptResults: [Promise.resolve("t")] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ text: "Kappa gg chat", emotes: [{ id: "25", start: 0, end: 4 }] }));
    await flush();

    expect(detect).toHaveBeenCalledWith("gg chat");
    stop();
  });

  it("学ぶ言語が複数のとき、判定した言語ごとに別のセッションプールを使う", async () => {
    const { deps, emit, detect } = createDeps({
      promptResults: [Promise.resolve("英語の結果"), Promise.resolve("スペイン語の結果")],
      settings: { learningLangs: ["en", "es"], explainLang: "ja" },
    });
    detect
      .mockResolvedValueOnce([{ detectedLanguage: "en", confidence: 0.9 }])
      .mockResolvedValueOnce([{ detectedLanguage: "es", confidence: 0.9 }]);

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-en", text: "gg chat" }));
    emit(createMessage({ id: "msg-es", text: "vamos equipo" }));
    await flush();

    expect(deps.createPool).toHaveBeenCalledTimes(2);
    expect(deps.createPool).toHaveBeenNthCalledWith(1, "en", "ja");
    expect(deps.createPool).toHaveBeenNthCalledWith(2, "es", "ja");
    expect(useStore.getState().entries["msg-en"]).toEqual({ status: "done", result: "英語の結果" });
    expect(useStore.getState().entries["msg-es"]).toEqual({ status: "done", result: "スペイン語の結果" });
    stop();
  });

  it("同じ学ぶ言語の発言が続いても、その言語のセッションプールは 1 つだけ生成する", async () => {
    const { deps, emit } = createDeps({ promptResults: [Promise.resolve("1"), Promise.resolve("2")] });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    emit(createMessage({ id: "msg-2" }));
    await flush();

    expect(deps.createPool).toHaveBeenCalledTimes(1);
    stop();
  });

  it("解説言語と同じ言語と判定した発言は、モデルを呼ばず same-language として保持する", async () => {
    const { deps, emit, enqueue } = createDeps({
      detectedLanguage: "ja",
      settings: { learningLangs: ["en", "ja"], explainLang: "ja" },
    });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "ナイスプレー" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(deps.createPool).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "same-language" });
    stop();
  });

  it("学ぶ言語にも解説言語にも該当しない発言は、判定した言語を添えて other-language として保持する", async () => {
    const { deps, emit, enqueue } = createDeps({ detectedLanguage: "ko" });

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "안녕하세요" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "other-language", detectedLanguage: "ko" });
    stop();
  });

  it("言語判定が失敗した場合は理由付きで failed として保持する(暗黙に学ぶ言語で処理しない)", async () => {
    const { deps, emit, detect, enqueue } = createDeps();
    detect.mockRejectedValueOnce(new Error("Language Detector がクラッシュしました"));

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useStore.getState().entries["msg-1"]).toEqual({
      status: "failed",
      reason: "Language Detector がクラッシュしました",
    });
    stop();
  });

  it("resolveWithoutModel が結果を返した発言は言語判定もしない", async () => {
    const { deps, emit, detect } = createDeps();

    const stop = start(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "skip: そのまま" }));
    await flush();

    expect(detect).not.toHaveBeenCalled();
    stop();
  });

  it("開始時に前回の結果をすべて破棄し、表示中の発言を新しいパイプラインに再投入する(言語ペア変更後の再生成)", async () => {
    const first = createDeps({ promptResults: [Promise.resolve("古い訳"), Promise.resolve("最初の言語ペアの訳")] });
    const stop = start(first.deps);
    await flush();
    first.emit(createMessage({ id: "msg-0", text: "hi" }));
    first.emit(createMessage({ id: "msg-1", text: "gg chat" }));
    await flush();
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "done", result: "最初の言語ペアの訳" });
    stop();

    // 言語ペアを変えて再開する。表示用リングバッファには msg-1 と ID を持たない発言だけが残っている(msg-0 は溢れて消えた)
    const second = createDeps({ promptResults: [Promise.resolve("新しい言語ペアの訳")] });
    second.setMessages([createMessage({ id: "msg-1", text: "gg chat" }), createMessage({ id: null })]);
    const stopAgain = start(second.deps);
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "pending" });
    await flush();

    expect(second.enqueue).toHaveBeenCalledTimes(1);
    expect(useStore.getState().entries).toEqual({ "msg-1": { status: "done", result: "新しい言語ペアの訳" } });
    stopAgain();
  });

  it("停止すると発言の購読を解除し、以後の発言ではジョブを投入しない", async () => {
    const { deps, emit, enqueue, listeners } = createDeps();

    const stop = start(deps);
    await flush();
    stop();
    emit(createMessage({ id: "msg-1" }));
    await flush();

    expect(listeners.size).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("診断待ちの保留は上限を超えると古いものから dropped にする", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, enqueue } = createDeps({
      promptResults: Array.from({ length: MAX_WAITING_FOR_DIAGNOSIS }, () => Promise.resolve("結果")),
    });
    deps.diagnose = () => diagnosis.promise;

    const stop = start(deps);
    for (let i = 0; i < MAX_WAITING_FOR_DIAGNOSIS + 1; i++) {
      emit(createMessage({ id: `msg-${i}` }));
    }
    await flush();
    expect(useStore.getState().entries["msg-0"]).toEqual({ status: "dropped" });
    expect(useStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(MAX_WAITING_FOR_DIAGNOSIS);
    expect(useStore.getState().entries["msg-0"]).toEqual({ status: "dropped" });
    stop();
  });

  it("診断待ちの間にリングバッファから消えた発言は、診断完了後に投入しない", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, emit, setMessages, enqueue } = createDeps({ promptResults: [Promise.resolve("結果")] });
    deps.diagnose = () => diagnosis.promise;

    const stop = start(deps);
    emit(createMessage({ id: "msg-1" }));
    setMessages([]);
    emit(createMessage({ id: "msg-2" }));
    await flush();

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(useStore.getState().entries["msg-1"]).toBeUndefined();
    expect(useStore.getState().entries["msg-2"]).toEqual({ status: "done", result: "結果" });
    stop();
  });

  it("2 つのパイプラインを開始しても環境診断は 1 回だけ実行し、共有の状態を参照する", async () => {
    const other = createAutoPipeline<EchoResult>({
      createBaseSession: () => async () => {
        throw new Error("テストでは createPool を注入するため呼ばれない");
      },
      runJob: async (pool, message, { signal }) => ({
        result: await pool.enqueue("low", (session) => session.prompt(message.text), signal),
      }),
    });
    const { deps } = createDeps({ ready: true });
    const otherDeps = createDeps({ ready: true }).deps;

    const stop = start(deps);
    const stopOther = other.start(otherDeps);
    await flush();

    expect(deps.diagnose).toHaveBeenCalledTimes(1);
    expect(otherDeps.diagnose).not.toHaveBeenCalled();
    expect(usePromptApiStore.getState().status).toEqual({ status: "ready" });
    stop();
    stopOther();
    other.resetForTests();
  });
});

describe("createAutoPipeline().warmUp", () => {
  it("診断が ready のとき、ユーザー操作の延長で Language Detector と学ぶ言語ごとのセッションプールを生成しウォームアップする", async () => {
    const { deps, warmUp, createDetector } = createDeps({
      ready: true,
      settings: { learningLangs: ["en", "es"], explainLang: "ja" },
    });

    const stop = start(deps);
    await flush();
    warmUpPipeline();
    await flush();

    expect(createDetector).toHaveBeenCalledTimes(1);
    expect(deps.createPool).toHaveBeenCalledTimes(2);
    expect(deps.createPool).toHaveBeenNthCalledWith(1, "en", "ja");
    expect(deps.createPool).toHaveBeenNthCalledWith(2, "es", "ja");
    expect(warmUp).toHaveBeenCalledTimes(2);
    stop();
  });

  it("学ぶ言語に解説言語が含まれていても、解説言語のセッションプールはウォームアップしない(その言語の発言は処理しないため)", async () => {
    const { deps, warmUp } = createDeps({
      ready: true,
      settings: { learningLangs: ["en", "ja"], explainLang: "ja" },
    });

    const stop = start(deps);
    await flush();
    warmUpPipeline();
    await flush();

    expect(deps.createPool).toHaveBeenCalledTimes(1);
    expect(deps.createPool).toHaveBeenCalledWith("en", "ja");
    expect(warmUp).toHaveBeenCalledTimes(1);
    stop();
  });

  it("Language Detector の生成に失敗した場合は共有の Prompt API 状態を unavailable にして理由を保持する", async () => {
    const { deps, createDetector } = createDeps({ ready: true });
    createDetector.mockRejectedValueOnce(new Error("NotAllowedError: user activation is required"));

    const stop = start(deps);
    await flush();
    warmUpPipeline();
    await flush();

    const promptApi = usePromptApiStore.getState().status;
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/Language Detector.*user activation/);
    stop();
  });

  it("診断が終わる前に呼ばれた場合は、診断が ready になった時点でウォームアップする", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const { deps, warmUp } = createDeps();
    deps.diagnose = () => diagnosis.promise;

    const stop = start(deps);
    warmUpPipeline();
    await flush();
    expect(warmUp).not.toHaveBeenCalled();

    diagnosis.resolve(createDiagnosis(true));
    await flush();
    expect(warmUp).toHaveBeenCalledTimes(1);
    stop();
  });

  it("Prompt API が利用できない場合はウォームアップしない", async () => {
    const { deps, warmUp } = createDeps({ ready: false });

    const stop = start(deps);
    await flush();
    warmUpPipeline();
    await flush();

    expect(warmUp).not.toHaveBeenCalled();
    stop();
  });

  it("ウォームアップに失敗した場合は共有の Prompt API 状態を unavailable にして理由を保持する", async () => {
    const { deps, warmUp } = createDeps({ ready: true });
    warmUp.mockRejectedValueOnce(new Error("NotAllowedError: user activation is required"));

    const stop = start(deps);
    await flush();
    warmUpPipeline();
    await flush();

    const promptApi = usePromptApiStore.getState().status;
    expect(promptApi.status).toBe("unavailable");
    expect(promptApi.status === "unavailable" && promptApi.reason).toMatch(/user activation/);
    stop();
  });

  it("パイプラインが開始されていない状態で呼んでも何もしない", () => {
    expect(() => warmUpPipeline()).not.toThrow();
  });
});

describe("createAutoPipeline().resetForTests", () => {
  it("エントリを空に戻す", () => {
    useStore.setState({ entries: { "msg-1": { status: "pending" } } });

    pipeline.resetForTests();

    expect(useStore.getState().entries).toEqual({});
  });
});
