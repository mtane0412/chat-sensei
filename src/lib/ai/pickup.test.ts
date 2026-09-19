/**
 * src/lib/ai/pickup.ts のテスト。
 *
 * `pickUpExpressions`: SessionPool 経由でチャット本文から注目の表現(語句と意味のペア)を
 * 抽出し、Gemini Nano が返したJSON文字列を zod でパース・検証するところまでを検証する
 * (共通処理 `runStructuredPrompt` に Pick up 用のプロンプト・スキーマが正しく渡ることの確認)。
 * ハイブリッド抽出(issue #116)では、表現リスト候補のプロンプトへの注入と、応答を候補集合と
 * 表現キーで照合する決定的検証(候補の採用 / 自由発見の仕分け・上限)を検証する。
 * `createPickupBaseSessionFactory`: 言語ペアから Pick up 専用のシステムプロンプトで
 * `LanguageModel.create()` を呼び出すセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込みAPIのため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import {
  createPickupBaseSessionFactory,
  MAX_INJECTED_PICKUP_CANDIDATES,
  MAX_PICKUP_DISCOVERIES,
  pickUpExpressions,
} from "./pickup";
import type { PickupCandidate } from "./pickup-candidates";
import { buildTermExpressionKey } from "./pickup-ordinary-filter";
import { buildExplainSystemPrompt, buildTranslateSystemPrompt } from "./prompts";
import type { SessionPool } from "./session-pool";
import { STRUCTURED_PROMPT_MAX_ATTEMPTS } from "./structured-prompt";

/** テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出し、prompt の引数を記録する */
/** 配列を渡した場合は、呼び出しごとに先頭から順に応答を返す(再試行の検証用) */
function createFakeSessionPool(promptResult: string | string[]) {
  const results = Array.isArray(promptResult) ? [...promptResult] : [promptResult];
  const prompt = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("テスト用の応答が尽きました");
    return next;
  });
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt });
  });
  return { enqueue, prompt } as unknown as SessionPool & { enqueue: typeof enqueue; prompt: typeof prompt };
}

const サンプル抽出結果 = {
  terms: [
    { term: "cooked", meaning: "もうダメ、終わってる" },
    { term: "touch grass", meaning: "外に出て現実を見ろ" },
  ],
};

describe("pickUpExpressions", () => {
  it("Gemini Nanoが返したJSONを語句と意味のペアの一覧としてパースして返す", async () => {
    const pool = createFakeSessionPool(JSON.stringify(サンプル抽出結果));

    const result = await pickUpExpressions(pool, "bro is cooked lmao touch grass");

    expect(result).toEqual(サンプル抽出結果);
  });

  it("抽出は全件自動生成のため、優先度を指定しない場合は既定で low として enqueue する", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), undefined);
  });

  it("優先度とsignalを指定した場合はそのままenqueueに渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));
    const controller = new AbortController();

    await pickUpExpressions(pool, "hello", { priority: "high", signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), controller.signal);
  });

  it("Pick up用のユーザープロンプトとPick up用のresponseConstraintでsession.promptを呼ぶ", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "gg chat");

    expect(pool.prompt).toHaveBeenCalledWith(
      expect.stringContaining("gg chat"),
      expect.objectContaining({
        responseConstraint: expect.objectContaining({ required: ["terms"] }),
      }),
    );
  });

  it("応答がJSONとして解釈できない場合はエラーを投げる", async () => {
    const pool = createFakeSessionPool("これはJSONではない文字列です");

    await expect(pickUpExpressions(pool, "hello")).rejects.toThrow();
  });

  it("応答のJSONがスキーマに合わない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ items: [{ term: "gg", meaning: "x" }] }));

    await expect(pickUpExpressions(pool, "hello")).rejects.toThrow();
  });
});

describe("pickUpExpressions(JSON 解釈失敗時の再試行、issue #19)", () => {
  it("応答が正常な場合は1回しか enqueue しない", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledTimes(1);
  });

  it("応答 JSON が途中で切れていた場合は、新しいジョブとして1回だけ再試行し、成功した結果を返す", async () => {
    const truncated = '{"terms":[{"term":"gg","meaning":"お疲れ';
    const pool = createFakeSessionPool([truncated, JSON.stringify({ terms: [{ term: "gg", meaning: "お疲れ様" }] })]);

    const result = await pickUpExpressions(pool, "gg chat");

    expect(result).toEqual({ terms: [{ term: "gg", meaning: "お疲れ様" }] });
    expect(pool.enqueue).toHaveBeenCalledTimes(2);
    expect(pool.enqueue).toHaveBeenNthCalledWith(2, "low", expect.any(Function), undefined);
  });

  it("再試行しても JSON として解釈できない場合は、それ以上再試行せず試行回数を含めたエラーを投げる", async () => {
    const pool = createFakeSessionPool(['{"terms":[{"term":"gg"', '{"terms":[']);

    await expect(pickUpExpressions(pool, "gg chat")).rejects.toThrow(
      `Could not parse the Prompt API response as JSON (${STRUCTURED_PROMPT_MAX_ATTEMPTS} attempts): {"terms":[`,
    );
    expect(pool.enqueue).toHaveBeenCalledTimes(STRUCTURED_PROMPT_MAX_ATTEMPTS);
  });

  it("JSON としては解釈できるがスキーマに合わない応答や、原文に無い語句を返した応答は再試行しない", async () => {
    const schemaMismatch = createFakeSessionPool([
      JSON.stringify({ items: [] }),
      JSON.stringify({ terms: [] }),
    ]);
    await expect(pickUpExpressions(schemaMismatch, "hello")).rejects.toThrow();
    expect(schemaMismatch.enqueue).toHaveBeenCalledTimes(1);

    const unknownTerm = createFakeSessionPool([
      JSON.stringify({ terms: [{ term: "了解", meaning: "分かった" }] }),
      JSON.stringify({ terms: [] }),
    ]);
    await expect(pickUpExpressions(unknownTerm, "hello")).rejects.toThrow();
    expect(unknownTerm.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe("pickUpExpressions(原文との照合)", () => {
  it("大文字小文字の違いは許容する(「W」を「w」として返しても原文の語句とみなす)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "w", meaning: "勝利" }] }));

    const result = await pickUpExpressions(pool, "that was a W");

    expect(result.terms).toEqual([{ term: "w", meaning: "勝利" }]);
  });

  it("返された語句がすべて原文に登場しない場合はエラーを投げる(解説言語の語や言い換えを原文の語句として表示しない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "了解", meaning: "分かった" }] }));

    await expect(pickUpExpressions(pool, "roger that")).rejects.toThrow(/does not appear in the message/);
  });

  it("言い換えられた語句だけを落とし、同じ発言から抽出された原文どおりの語句は返す(issue #120)", async () => {
    // 前提: 本文は "slept on a really good mattress"。モデルが "slept on a mattress" と言い換えて返した
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "slept on a mattress", meaning: "マットレスで寝た" },
          { term: "no cap", meaning: "マジで、嘘じゃなく" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "never slept on a really good mattress no cap");

    // 検証: 言い換えの1件のせいで全滅せず、原文どおりの語句は残る
    expect(result.terms).toEqual([{ term: "no cap", meaning: "マジで、嘘じゃなく" }]);
  });

  it("別の単語の一部にしか現れない語句は、原文の語句とみなさず落とす(単語境界での照合)", async () => {
    // 前提: "w" は "wow" の一部としてしか現れない。"cooked" は独立した語として現れる
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "w", meaning: "勝利" },
          { term: "cooked", meaning: "もうダメ、終わってる" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "wow he is cooked");

    expect(result.terms).toEqual([{ term: "cooked", meaning: "もうダメ、終わってる" }]);
  });

  it("語句の前後が記号・句読点の場合は、単語の境界として原文の語句とみなす", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "cooked", meaning: "もうダメ、終わってる" }] }));

    const result = await pickUpExpressions(pool, "bro is (cooked)!!");

    expect(result.terms).toEqual([{ term: "cooked", meaning: "もうダメ、終わってる" }]);
  });

  it("アクセント付き文字の表現方法(合成済み / 結合文字)が本文と語句で違っていても、同じ語句として照合する", async () => {
    // 前提: 本文の "é" は「e + 結合アクセント」(NFD)、モデルが返した語句の "é" は合成済みの1文字(NFC)
    const 本文 = "on va au cafe\u0301 ce soir";
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "caf\u00e9", meaning: "喫茶店" }] }));

    const result = await pickUpExpressions(pool, 本文);

    expect(result.terms).toEqual([{ term: "caf\u00e9", meaning: "喫茶店" }]);
  });

  it("分かち書きをしない言語の語句は、前後に文字が続いていても原文の語句とみなす", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "草生える", meaning: "laughing hard" }] }));

    const result = await pickUpExpressions(pool, "それは草生えるわ");

    expect(result.terms).toEqual([{ term: "草生える", meaning: "laughing hard" }]);
  });
});

describe("pickUpExpressions(決定的な足切りと後段フィルタ、issue #26)", () => {
  it("emote だけの発言は LLM を呼ばずに terms が空の結果を返す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "Kappa", meaning: "皮肉" }] }));

    const result = await pickUpExpressions(pool, "Kappa", { emotes: [{ id: "25", start: 0, end: 4 }] });

    expect(result).toEqual({ terms: [] });
    expect(pool.enqueue).not.toHaveBeenCalled();
  });

  it("emote・@メンション・URL を除いた本文をユーザープロンプトに渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "xqcPeepo @AUBREY DID THAT https://example.com/clip", {
      emotes: [{ id: "emotesv2_1", start: 0, end: 7 }],
    });

    const [userPrompt] = pool.prompt.mock.calls[0] as unknown as [string];
    expect(userPrompt).toContain("DID THAT");
    expect(userPrompt).not.toContain("xqcPeepo");
    expect(userPrompt).not.toContain("@AUBREY");
    expect(userPrompt).not.toContain("https://example.com/clip");
  });

  it("モデルが emote 名・@メンション・数字だけの語句を返しても、エラーにせず結果から落とす", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "xqcPeepo", meaning: "配信者関連の絵文字" },
          { term: "@AUBREY", meaning: "視聴者への呼称" },
          { term: "67", meaning: "数字のミーム" },
          { term: "sticky", meaning: "スタン状態にする" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "xqcPeepo @AUBREY 67 sticky", {
      emotes: [{ id: "emotesv2_1", start: 0, end: 7 }],
    });

    expect(result.terms).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("excludedNames に指定した発言者名を、モデルが語句として返しても結果から落とす", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "space_toilet_master", meaning: "配信の常連" },
          { term: "sticky", meaning: "スタン状態にする" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "Welcome back space_toilet_master! sticky", {
      excludedNames: ["space_toilet_master"],
    });

    expect(result.terms).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("emotes を省略した場合は emote 除去を行わず、本文をそのまま渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "Kappa lol");

    expect(pool.prompt).toHaveBeenCalledWith(expect.stringContaining("Kappa lol"), expect.anything());
  });
});

describe("pickUpExpressions(ハイブリッド抽出: 候補の注入と決定的検証、issue #116)", () => {
  /** 本文に依らず固定の候補を返す候補生成関数のフェイク。渡された本文を記録する */
  function createFakeFindCandidates(candidates: PickupCandidate[]) {
    return vi.fn((text: string) => {
      void text;
      return candidates;
    });
  }

  const 候補_even_though: PickupCandidate = { term: "even though", expressionKey: buildTermExpressionKey("even though") };
  const 候補_kind_of: PickupCandidate = { term: "kind of", expressionKey: buildTermExpressionKey("kind of") };

  it("候補生成関数には emote・@メンション・URL を除いた本文を渡し、得た候補をユーザープロンプトに注入する", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));
    const findCandidates = createFakeFindCandidates([候補_even_though, 候補_kind_of]);

    await pickUpExpressions(pool, "@AUBREY even though it rained we kind of won", { findCandidates });

    expect(findCandidates).toHaveBeenCalledWith("even though it rained we kind of won");
    const [userPrompt] = pool.prompt.mock.calls[0] as unknown as [string];
    expect(userPrompt).toContain('"even though", "kind of"');
  });

  it("候補が1件も無い発言では、候補に関する指示をユーザープロンプトに含めない", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "gg chat", { findCandidates: createFakeFindCandidates([]) });

    const [userPrompt] = pool.prompt.mock.calls[0] as unknown as [string];
    expect(userPrompt).not.toContain("Candidate");
  });

  it("注入する候補は暫定の上限件数までに絞る(本文中の出現順で先頭から)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));
    // 上限より1件多い候補を用意する("expression 0" 〜)
    const manyCandidates = Array.from({ length: MAX_INJECTED_PICKUP_CANDIDATES + 1 }, (_, index) => ({
      term: `expression ${String(index)}`,
      expressionKey: `expression ${String(index)}`,
    }));

    await pickUpExpressions(pool, "候補が多い発言の本文", { findCandidates: createFakeFindCandidates(manyCandidates) });

    const [userPrompt] = pool.prompt.mock.calls[0] as unknown as [string];
    expect(userPrompt).toContain(`"expression ${String(MAX_INJECTED_PICKUP_CANDIDATES - 1)}"`);
    expect(userPrompt).not.toContain(`"expression ${String(MAX_INJECTED_PICKUP_CANDIDATES)}"`);
  });

  it("モデルが返さなかった候補は、失敗ではなく文脈での不採用として結果に含めない", async () => {
    // "kind of" は「種類」の字義通りの用法としてモデルが不採用にした想定
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "even though", meaning: "〜だけれども" }] }));

    const result = await pickUpExpressions(pool, "even though it is a rare kind of bird", {
      findCandidates: createFakeFindCandidates([候補_even_though, 候補_kind_of]),
    });

    expect(result.terms).toEqual([{ term: "even though", meaning: "〜だけれども" }]);
  });

  it("モデルが候補を語形違い・大文字違いで返しても、表現キーの照合で候補の採用とみなし、本文中の表面形で返す", async () => {
    // 本文は "picked up"。モデルは原形 "Pick up" で返した(原文の部分文字列ではない)
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "Pick up", meaning: "拾う、覚える" }] }));
    const 候補_picked_up: PickupCandidate = { term: "picked up", expressionKey: buildTermExpressionKey("picked up") };

    const result = await pickUpExpressions(pool, "I picked up some slang", {
      findCandidates: createFakeFindCandidates([候補_picked_up]),
    });

    // 原文照合エラーにはならず、語句は候補(本文)の表面形になる
    expect(result.terms).toEqual([{ term: "picked up", meaning: "拾う、覚える" }]);
  });

  it("モデルが同じ候補を重複して返した場合は最初の1件だけ残す", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "picked up", meaning: "拾った、覚えた" },
          { term: "pick up", meaning: "拾う" },
        ],
      }),
    );
    const 候補_picked_up: PickupCandidate = { term: "picked up", expressionKey: buildTermExpressionKey("picked up") };

    const result = await pickUpExpressions(pool, "I picked up some slang", {
      findCandidates: createFakeFindCandidates([候補_picked_up]),
    });

    expect(result.terms).toEqual([{ term: "picked up", meaning: "拾った、覚えた" }]);
  });

  it("候補に無い語句は自由発見として扱い、上限件数を超えた分は結果から落とす(候補の採用は上限に数えない)", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "malding", meaning: "ハゲるほどキレること" },
          { term: "even though", meaning: "〜だけれども" },
          { term: "copium", meaning: "現実逃避の言い訳" },
          { term: "ratio", meaning: "返信の方が伸びること" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "even though he is malding it is pure copium ratio", {
      findCandidates: createFakeFindCandidates([候補_even_though]),
    });

    // 自由発見は先頭から MAX_PICKUP_DISCOVERIES(2)件まで。モデルが返した順序は保つ
    expect(MAX_PICKUP_DISCOVERIES).toBe(2);
    expect(result.terms).toEqual([
      { term: "malding", meaning: "ハゲるほどキレること" },
      { term: "even though", meaning: "〜だけれども" },
      { term: "copium", meaning: "現実逃避の言い訳" },
    ]);
  });

  it("自由発見には原文照合を課し、本文に無い語句だけを落として採用された候補は返す(issue #120)", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({
        terms: [
          { term: "even though", meaning: "〜だけれども" },
          { term: "了解", meaning: "分かった" },
        ],
      }),
    );

    const result = await pickUpExpressions(pool, "even though it rained we won", {
      findCandidates: createFakeFindCandidates([候補_even_though]),
    });

    expect(result.terms).toEqual([{ term: "even though", meaning: "〜だけれども" }]);
  });

  it("本文に無い語句は自由発見の上限件数に数えない", async () => {
    // 前提: 自由発見の先頭が言い換え(本文に無い)。残りの自由発見は上限件数ちょうど
    const 本文にある自由発見 = [
      { term: "malding", meaning: "ハゲるほどキレること" },
      { term: "copium", meaning: "現実逃避の言い訳" },
    ];
    expect(本文にある自由発見).toHaveLength(MAX_PICKUP_DISCOVERIES);
    const pool = createFakeSessionPool(
      JSON.stringify({ terms: [{ term: "raining hard", meaning: "激しい雨" }, ...本文にある自由発見] }),
    );

    const result = await pickUpExpressions(pool, "even though it rained he is malding on copium", {
      findCandidates: createFakeFindCandidates([候補_even_though]),
    });

    expect(result.terms).toEqual(本文にある自由発見);
  });

  it("候補が無い発言(他言語など)では自由発見の上限を課さず、従来どおりすべて返す", async () => {
    const terms = [
      { term: "malding", meaning: "ハゲるほどキレること" },
      { term: "copium", meaning: "現実逃避の言い訳" },
      { term: "ratio", meaning: "返信の方が伸びること" },
    ];
    const pool = createFakeSessionPool(JSON.stringify({ terms }));

    const result = await pickUpExpressions(pool, "malding copium ratio", {
      findCandidates: createFakeFindCandidates([]),
    });

    expect(result.terms).toEqual(terms);
  });
});

describe("createPickupBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Pick up専用のsystem promptとexpectedInputs/expectedOutputsでLanguageModel.createを呼ぶ", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
      expectedInputs: Array<{ type: string; languages: string[] }>;
      expectedOutputs: Array<{ type: string; languages: string[] }>;
    }

    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });

    const factory = createPickupBaseSessionFactory(DEFAULT_SETTINGS, "en", "ja");
    const session = await factory();

    expect(session).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0];
    expect(options.initialPrompts).toHaveLength(1);
    expect(options.initialPrompts[0].role).toBe("system");
    expect(options.initialPrompts[0].content).toContain("日本語");
    // 解説用・翻訳用のシステムプロンプトを流用していないこと
    expect(options.initialPrompts[0].content).not.toBe(buildExplainSystemPrompt("en", "ja"));
    expect(options.initialPrompts[0].content).not.toBe(buildTranslateSystemPrompt("en", "ja"));
    expect(options.expectedInputs).toEqual([{ type: "text", languages: ["en", "ja"] }]);
    expect(options.expectedOutputs).toEqual([{ type: "text", languages: ["ja"] }]);
  });
});

describe("createPickupBaseSessionFactory と配信の文脈(issue #54)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("配信情報を渡すと、システムプロンプトに配信タイトル・カテゴリが含まれる", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
    }
    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });

    const factory = createPickupBaseSessionFactory(DEFAULT_SETTINGS, "en", "ja", {
      title: "Mythic raid progression! !drops",
      category: "World of Warcraft",
    });
    await factory();

    const content = create.mock.calls[0][0].initialPrompts[0].content;
    expect(content).toContain("Mythic raid progression! !drops");
    expect(content).toContain("World of Warcraft");
  });
});

