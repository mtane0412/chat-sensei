/**
 * src/store/translations.ts(翻訳結果ストア + 翻訳パイプライン)のテスト。
 *
 * パイプラインに共通する振る舞い(保留・投入・失敗・キュー溢れ・ウォームアップなど)は
 * `auto-pipeline.test.ts` が検証するため、ここでは翻訳固有の振る舞い ―― どの発言を LLM に渡さず
 * 原文のまま確定させるか、訳文をどの形で保持するか ―― だけを検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { createDeps, createMessage, flush } from "./pipeline-test-fixtures";
import { resetPromptApiStoreForTests } from "./prompt-api";
import { resetTranslationStoreForTests, startTranslationPipeline, useTranslationStore } from "./translations";

afterEach(() => {
  resetTranslationStoreForTests();
  resetPromptApiStoreForTests();
});

describe("startTranslationPipeline", () => {
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

  it("emote だけの発言は訳すものが無いため LLM を呼ばず、原文をそのまま訳文として done にする(issue #28)", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(
      createMessage({
        id: "msg-1",
        text: "sayuwuKuru sayuwuKuru",
        emotes: [
          { id: "emotesv2_1", start: 0, end: 9 },
          { id: "emotesv2_1", start: 11, end: 20 },
        ],
      }),
    );
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      translation: "sayuwuKuru sayuwuKuru",
    });
    stop();
  });

  it("`!` で始まるチャットコマンドは翻訳せず LLM を呼ばず、原文をそのまま訳文として done にする(issue #35)", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startTranslationPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "!chimkin please" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(useTranslationStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      translation: "!chimkin please",
    });
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
});
