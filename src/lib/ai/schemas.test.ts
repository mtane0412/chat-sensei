/**
 * src/lib/ai/schemas.ts のテスト。
 *
 * 解説結果・翻訳結果・Pick up(語句と意味のペア)のスキーマ(zod)が JSON.parse された Gemini Nano の出力を
 * 正しく検証できること、および Prompt API の `responseConstraint` に渡す
 * JSON Schema を `toResponseConstraint` で組み立てられることを検証する。
 */
import { describe, expect, it } from "vitest";
import { explanationSchema, pickupSchema, toResponseConstraint, translationSchema } from "./schemas";

describe("explanationSchema", () => {
  it("正しい形のオブジェクトをパースできる", () => {
    // "chat is this real" という発言に対する解説結果を想定したサンプル
    const raw = {
      translation: "これは本当ですか、チャット",
      literal: "チャット、これは本物ですか",
      items: [
        {
          term: "chat",
          kind: "slang",
          meaning: "視聴者・配信のコミュニティ全体を指す呼びかけ",
          note: "配信者が視聴者へ話しかけるときの定番表現",
        },
      ],
      difficulty: 2,
    };

    const result = explanationSchema.parse(raw);
    expect(result).toEqual(raw);
  });

  it("kindが許可された値以外の場合はパースエラーになる", () => {
    const raw = {
      translation: "t",
      literal: "l",
      items: [{ term: "x", kind: "unknown-kind", meaning: "m", note: "n" }],
      difficulty: 1,
    };

    expect(() => explanationSchema.parse(raw)).toThrow();
  });

  it("difficultyが1〜5の範囲外の場合はパースエラーになる", () => {
    const raw = { translation: "t", literal: "l", items: [], difficulty: 6 };

    expect(() => explanationSchema.parse(raw)).toThrow();
  });

  it("必須フィールドが欠けている場合はパースエラーになる", () => {
    const raw = { translation: "t", literal: "l" };

    expect(() => explanationSchema.parse(raw)).toThrow();
  });
});

describe("toResponseConstraint(explanationSchema)", () => {
  it("Prompt APIのresponseConstraintに渡せるJSON Schemaオブジェクトを返す", () => {
    const constraint = toResponseConstraint(explanationSchema);

    expect(constraint).toMatchObject({
      type: "object",
      properties: {
        translation: { type: "string" },
        literal: { type: "string" },
        difficulty: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["translation", "literal", "items", "difficulty"],
    });
  });

  it("メタ情報の$schemaフィールドは含まない(Prompt APIの想定外のため)", () => {
    const constraint = toResponseConstraint(explanationSchema) as Record<string, unknown>;

    expect(constraint.$schema).toBeUndefined();
  });
});

describe("translationSchema", () => {
  it("訳文だけを持つ最小構造をパースできる", () => {
    const raw = { translation: "ナイスプレー、チャット" };

    expect(translationSchema.parse(raw)).toEqual(raw);
  });

  it("translationが欠けている場合はパースエラーになる", () => {
    expect(() => translationSchema.parse({})).toThrow();
  });

  it("translationが文字列でない場合はパースエラーになる", () => {
    expect(() => translationSchema.parse({ translation: 123 })).toThrow();
  });
});

describe("toResponseConstraint(translationSchema)", () => {
  it("訳文のみを要求するJSON Schemaオブジェクトを返す", () => {
    const constraint = toResponseConstraint(translationSchema);

    expect(constraint).toMatchObject({
      type: "object",
      properties: { translation: { type: "string" } },
      required: ["translation"],
    });
  });

  it("メタ情報の$schemaフィールドは含まない(Prompt APIの想定外のため)", () => {
    const constraint = toResponseConstraint(translationSchema) as Record<string, unknown>;

    expect(constraint.$schema).toBeUndefined();
  });
});

describe("pickupSchema", () => {
  it("語句と意味のペアの配列をパースできる", () => {
    // "bro is cooked lmao touch grass" という発言に対する抽出結果を想定したサンプル
    const raw = {
      terms: [
        { term: "cooked", meaning: "もうダメ、終わってる" },
        { term: "touch grass", meaning: "外に出て現実を見ろ" },
      ],
    };

    expect(pickupSchema.parse(raw)).toEqual(raw);
  });

  it("該当する表現が無い場合の空配列をパースできる", () => {
    expect(pickupSchema.parse({ terms: [] })).toEqual({ terms: [] });
  });

  it("termsが欠けている場合はパースエラーになる", () => {
    expect(() => pickupSchema.parse({})).toThrow();
  });

  it("ペアにmeaningが無い場合はパースエラーになる", () => {
    expect(() => pickupSchema.parse({ terms: [{ term: "gg" }] })).toThrow();
  });

  it("termまたはmeaningが空文字の場合はパースエラーになる(中身の無いペアを描画しない)", () => {
    expect(() => pickupSchema.parse({ terms: [{ term: "", meaning: "意味" }] })).toThrow();
    expect(() => pickupSchema.parse({ terms: [{ term: "gg", meaning: "" }] })).toThrow();
  });
});

describe("toResponseConstraint(pickupSchema)", () => {
  it("語句と意味のペアの配列を要求するJSON Schemaオブジェクトを返す", () => {
    const constraint = toResponseConstraint(pickupSchema);

    expect(constraint).toMatchObject({
      type: "object",
      properties: {
        terms: {
          type: "array",
          items: {
            type: "object",
            properties: { term: { type: "string" }, meaning: { type: "string" } },
            required: ["term", "meaning"],
          },
        },
      },
      required: ["terms"],
    });
  });

  it("メタ情報の$schemaフィールドは含まない(Prompt APIの想定外のため)", () => {
    const constraint = toResponseConstraint(pickupSchema) as Record<string, unknown>;

    expect(constraint.$schema).toBeUndefined();
  });
});
