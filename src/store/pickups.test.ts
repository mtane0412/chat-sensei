/**
 * src/store/pickups.ts(Pick up 結果ストア + Pick up パイプライン)のテスト。
 *
 * パイプラインに共通する振る舞い(保留・投入・失敗・キュー溢れ・ウォームアップなど)は
 * `auto-pipeline.test.ts` が検証するため、ここでは Pick up 固有の振る舞い ―― どの発言を LLM に渡さず
 * 空の結果で確定させるか、発言者名を除外名として渡すか、語句一覧をどの形で保持するか ―― だけを検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { resetPickupEncountersForTests } from "./pickup-encounters";
import { resetPickupStoreForTests, startPickupPipeline, usePickupStore } from "./pickups";
import { createDeps, createMessage, flush } from "./pipeline-test-fixtures";
import { resetPromptApiStoreForTests } from "./prompt-api";
import { resetTranslationStoreForTests, useTranslationStore } from "./translations";

/** 「gg chat」に対する抽出結果(gg を略語として拾った想定)*/
const 抽出結果 = { terms: [{ term: "gg", meaning: "good game の略、お疲れ" }] };

afterEach(() => {
  resetPickupStoreForTests();
  resetTranslationStoreForTests();
  resetPromptApiStoreForTests();
  // 既出管理(issue #108)の遭遇記録はテストをまたいで持ち越さない
  window.localStorage.clear();
  resetPickupEncountersForTests();
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

  it("普通の単語・字義通りの句(高頻度語リスト・表現リストによる判定。issue #95)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      promptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              // Gemini Nano が指示を守らず返した普通の単語(実際の配信で観測した実例)
              { term: "rare", meaning: "珍しい" },
              // 高頻度語だけで構成される句動詞は表現リストにあるため残る
              { term: "give up", meaning: "諦める" },
              { term: "gg", meaning: "good game の略、お疲れ" },
            ],
          }),
        ),
      ],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "rare drop! never give up, gg" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [
        { term: "give up", meaning: "諦める" },
        { term: "gg", meaning: "good game の略、お疲れ" },
      ],
    });
    stop();
  });

  it("文中に固有名詞を含む句と、疑問文まるごとの抽出(issue #100)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      promptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              // ブランド名(固有名詞)を含む疑問文がまるごと抽出されたケース(issue #100 の観測例に相当)
              { term: "Do you mean Snickers?", meaning: "スニッカーズのこと?" },
              // 固有名詞を含まない疑問文まるごとの抽出
              { term: "are you malding right now?", meaning: "今キレてるの?" },
              { term: "malding", meaning: "ハゲるほどキレること" },
            ],
          }),
        ),
      ],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "Do you mean Snickers? are you malding right now?" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "malding", meaning: "ハゲるほどキレること" }],
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

describe("startPickupPipeline(逆方向: 翻訳パイプラインの訳文を再利用して抽出。issue #68)", () => {
  it("解説言語と判定した発言は、翻訳ストアの訳文(学ぶ言語)を待ち、その訳文に対して逆方向のセッションプールで抽出する", async () => {
    const { deps, emit, enqueue, reverseEnqueue, reversePrompt } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [Promise.resolve(JSON.stringify({ terms: [{ term: "fr", meaning: "for real の略。マジで" }] }))],
    });
    // 翻訳パイプラインが先に生成した訳文(翻訳列に表示されるもの)を注入する。emote は空白として扱う
    useTranslationStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          segments: [
            { type: "text", text: "fr that's true " },
            { type: "emote", id: "25", text: "Kappa" },
          ],
        },
      },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "それなwww" }));
    await flush();

    expect(enqueue).not.toHaveBeenCalled();
    expect(reverseEnqueue).toHaveBeenCalledWith("low", expect.any(Function), expect.any(AbortSignal));
    // LLM には原文(日本語)ではなく訳文を渡し、順方向と同じ terms のみの responseConstraint で呼ぶ
    // (訳文の再生成をしないことが issue #68 の主旨)
    expect(reversePrompt).toHaveBeenCalledWith(
      expect.stringContaining("fr that's true"),
      expect.objectContaining({
        responseConstraint: expect.objectContaining({ required: ["terms"] }),
      }),
    );
    expect(reversePrompt).not.toHaveBeenCalledWith(expect.stringContaining("それなwww"), expect.anything());
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "fr", meaning: "for real の略。マジで" }],
    });
    stop();
  });

  it("訳文がまだ生成中(エントリ無し)の間は pending のまま待ち、訳文が done になった時点で抽出する", async () => {
    const { deps, emit, reverseEnqueue } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [Promise.resolve(JSON.stringify({ terms: [] }))],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "それなwww" }));
    await flush();
    expect(reverseEnqueue).not.toHaveBeenCalled();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "pending" });

    useTranslationStore.setState({
      entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "that's so true" }] } },
    });
    await flush();

    expect(reverseEnqueue).toHaveBeenCalledTimes(1);
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "done", terms: [] });
    stop();
  });

  it("翻訳が failed の場合は訳文が得られないため、理由付きで failed として保持する(暗黙のフォールバックはしない)", async () => {
    const { deps, emit, reverseEnqueue } = createDeps({ detectedLanguage: "ja" });
    useTranslationStore.setState({ entries: { "msg-1": { status: "failed", reason: "モデルがクラッシュしました" } } });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "それなwww" }));
    await flush();

    expect(reverseEnqueue).not.toHaveBeenCalled();
    const entry = usePickupStore.getState().entries["msg-1"];
    expect(entry?.status).toBe("failed");
    expect(entry?.status === "failed" && entry.reason).toMatch(/モデルがクラッシュしました/);
    stop();
  });

  it("翻訳が dropped(流量超過)の場合は Pick up も dropped として保持する", async () => {
    const { deps, emit } = createDeps({ detectedLanguage: "ja" });
    useTranslationStore.setState({ entries: { "msg-1": { status: "dropped" } } });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "それなwww" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({ status: "dropped" });
    stop();
  });

  it("逆方向でも表示中の発言者名(username / displayName)を除外名として渡し、モデルが返しても結果から落とす", async () => {
    const { deps, emit } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              { term: "viewer_taro", meaning: "配信の常連" },
              { term: "no cap", meaning: "嘘じゃない、マジで" },
            ],
          }),
        ),
      ],
    });
    useTranslationStore.setState({
      entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "welcome back viewer_taro, no cap" }] } },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "おかえりviewer_taro、マジだよ" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }],
    });
    stop();
  });

  it("逆方向でも普通の単語・字義通りの句(issue #95)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              // 機械翻訳の訳文から Gemini Nano が拾った字義通りの句(実際の配信で観測した実例)
              { term: "main quests", meaning: "メインクエスト" },
              { term: "no cap", meaning: "嘘じゃない、マジで" },
            ],
          }),
        ),
      ],
    });
    useTranslationStore.setState({
      entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "did the main quests, no cap" }] } },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "メインクエやったよ、マジで" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }],
    });
    stop();
  });

  it("逆方向では機械翻訳が作った固有名詞的な語句(大文字小文字の混在・大文字始まりのハイフン語)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              // 「エオルゼア」の誤訳として機械翻訳が作った実在しない略記
              { term: "EoR", meaning: "Final Fantasy XIV略称(世界観)" },
              // 挨拶「こんとめー」が音写のまま訳文に残ったもの
              { term: "Conto-me", meaning: "話してくれ！(相槌の表現)" },
              { term: "no cap", meaning: "嘘じゃない、マジで" },
            ],
          }),
        ),
      ],
    });
    useTranslationStore.setState({
      entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "Conto-me! EoR is done, no cap" }] } },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "こんとめー！エオルゼアは終わりや、マジで" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }],
    });
    stop();
  });

  it("逆方向でも疑問文まるごとの抽出(issue #100)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [
        Promise.resolve(
          JSON.stringify({
            terms: [
              // 訳文(疑問文)ほぼ全体が1つの「表現」として返ったケース
              { term: "are you malding right now?", meaning: "今キレてるの?" },
              { term: "no cap", meaning: "嘘じゃない、マジで" },
            ],
          }),
        ),
      ],
    });
    useTranslationStore.setState({
      entries: {
        "msg-1": { status: "done", segments: [{ type: "text", text: "are you malding right now? no cap" }] },
      },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "今キレてるん？マジで" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }],
    });
    stop();
  });
});

describe("startPickupPipeline(既出管理: クールダウン内の再表示抑制。issue #108)", () => {
  it("順方向: 別の発言でクールダウン内に再抽出された同じ表現(語形変化を含む)を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      promptResults: [
        Promise.resolve(JSON.stringify({ terms: [{ term: "picked up", meaning: "拾った、覚えた" }] })),
        Promise.resolve(
          JSON.stringify({
            terms: [
              // 1件目の発言で表示済みの表現(語形違い)。クールダウン内のため抑制される
              { term: "pick up", meaning: "拾う、覚える" },
              { term: "malding", meaning: "ハゲるほどキレること" },
            ],
          }),
        ),
      ],
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "I picked up some slang" }));
    await flush();
    emit(createMessage({ id: "msg-2", text: "pick up the pace, malding already?" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "picked up", meaning: "拾った、覚えた" }],
    });
    expect(usePickupStore.getState().entries["msg-2"]).toEqual({
      status: "done",
      terms: [{ term: "malding", meaning: "ハゲるほどキレること" }],
    });
    stop();
  });

  it("逆方向: 別の発言の訳文からクールダウン内に再抽出された同じ表現を結果から落とす", async () => {
    const { deps, emit } = createDeps({
      detectedLanguage: "ja",
      reversePromptResults: [
        Promise.resolve(JSON.stringify({ terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }] })),
        Promise.resolve(
          JSON.stringify({
            terms: [
              // 1件目の訳文で表示済みの表現。クールダウン内のため抑制される
              { term: "no cap", meaning: "嘘じゃない、マジで" },
              { term: "fr", meaning: "for real の略。マジで" },
            ],
          }),
        ),
      ],
    });
    useTranslationStore.setState({
      entries: {
        "msg-1": { status: "done", segments: [{ type: "text", text: "that was insane, no cap" }] },
        "msg-2": { status: "done", segments: [{ type: "text", text: "no cap it was crazy fr" }] },
      },
    });

    const stop = startPickupPipeline(deps);
    await flush();
    emit(createMessage({ id: "msg-1", text: "やばかった、マジで" }));
    await flush();
    emit(createMessage({ id: "msg-2", text: "マジでやばかったって" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "no cap", meaning: "嘘じゃない、マジで" }],
    });
    expect(usePickupStore.getState().entries["msg-2"]).toEqual({
      status: "done",
      terms: [{ term: "fr", meaning: "for real の略。マジで" }],
    });
    stop();
  });

  it("順方向で表示済みの表現は、パイプライン再起動(言語設定変更等)で同じ発言が再抽出されても消えない", async () => {
    const promptResult = JSON.stringify({ terms: [{ term: "even though", meaning: "〜だけれども" }] });
    const first = createDeps({ promptResults: [Promise.resolve(promptResult)] });

    const stop1 = startPickupPipeline(first.deps);
    await flush();
    first.emit(createMessage({ id: "msg-1", text: "even though it rained we won" }));
    await flush();
    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "even though", meaning: "〜だけれども" }],
    });
    stop1();
    resetPickupStoreForTests();

    // 再起動後、同じ発言が再抽出される(hidden-pickups.ts に記載の再生成の挙動)。
    // 最終表示と同じメッセージIDのため、クールダウン内でも抑制せずに表示する
    const second = createDeps({ promptResults: [Promise.resolve(promptResult)] });
    const stop2 = startPickupPipeline(second.deps);
    await flush();
    second.emit(createMessage({ id: "msg-1", text: "even though it rained we won" }));
    await flush();

    expect(usePickupStore.getState().entries["msg-1"]).toEqual({
      status: "done",
      terms: [{ term: "even though", meaning: "〜だけれども" }],
    });
    stop2();
  });
});
