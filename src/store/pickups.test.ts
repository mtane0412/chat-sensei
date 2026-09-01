/**
 * src/store/pickups.ts(Pick up 結果ストア + Pick up パイプライン)のテスト。
 *
 * パイプラインに共通する振る舞い(保留・投入・失敗・キュー溢れ・ウォームアップなど)は
 * `auto-pipeline.test.ts` が検証するため、ここでは Pick up 固有の振る舞い ―― どの発言を LLM に渡さず
 * 空の結果で確定させるか、発言者名を除外名として渡すか、語句一覧をどの形で保持するか ―― だけを検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetPickupStoreForTests, startPickupPipeline, usePickupStore } from "./pickups";
import { createDeps, createMessage, flush } from "./pipeline-test-fixtures";
import { resetPromptApiStoreForTests } from "./prompt-api";

/** 「gg chat」に対する抽出結果(gg を略語として拾った想定)*/
const 抽出結果 = { terms: [{ term: "gg", meaning: "good game の略、お疲れ" }] };

afterEach(() => {
  resetPickupStoreForTests();
  resetPromptApiStoreForTests();
});

describe("startPickupPipeline", () => {
  it("受信した発言を low 優先度で抽出ジョブに積み、完了したら発言 ID に紐づけて語句と意味のペアを保持する", async () => {
    const { deps, emit, enqueue } = createDeps({ promptResults: [Promise.resolve(JSON.stringify(抽出結果))] });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "gg chat" }));
    await flush();

    expect(enqueue).toHaveBeenCalledWith("low", expect.any(Function), expect.any(AbortSignal));
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: 抽出結果.terms });
    stop();
  });

  it("emote だけの発言は言語判定も LLM 呼び出しもせずに terms が空の done として保持する(issue #26。判定すると und で対象外になってしまうため)", async () => {
    const { deps, emit, enqueue, detect } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "Kappa", emotes: [{ id: "25", start: 0, end: 4 }] }));
    await flush();

    expect(detect).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("Unicode 絵文字だけの発言も言語判定も LLM 呼び出しもせずに terms が空の done として保持する", async () => {
    const { deps, emit, enqueue, detect } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "☀️" }));
    await flush();

    expect(detect).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("`!` で始まるチャットコマンドは LLM を呼ばずに terms が空の done として保持する(issue #35)", async () => {
    const { deps, emit, enqueue } = createDeps();

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "!chimkin please" }));
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
});
