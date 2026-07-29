/**
 * src/lib/ai/schemas.ts のテスト。
 *
 * 解説結果のスキーマ(zod)が JSON.parse された Gemini Nano の出力を
 * 正しく検証できること、および Prompt API の `responseConstraint` に渡す
 * JSON Schema を組み立てられることを検証する。
 */
import { describe, expect, it } from "vitest";
import {
  buildExplanationResponseConstraint,
  buildTriageResponseConstraint,
  explanationSchema,
  triageResultSchema,
} from "./schemas";

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

describe("buildExplanationResponseConstraint", () => {
  it("Prompt APIのresponseConstraintに渡せるJSON Schemaオブジェクトを返す", () => {
    const constraint = buildExplanationResponseConstraint();

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
    const constraint = buildExplanationResponseConstraint() as Record<string, unknown>;

    expect(constraint.$schema).toBeUndefined();
  });
});

describe("triageResultSchema", () => {
  it("真偽値をパースできる", () => {
    expect(triageResultSchema.parse(true)).toBe(true);
    expect(triageResultSchema.parse(false)).toBe(false);
  });

  it("真偽値以外はパースエラーになる", () => {
    expect(() => triageResultSchema.parse("true")).toThrow();
    expect(() => triageResultSchema.parse(1)).toThrow();
  });
});

describe("buildTriageResponseConstraint", () => {
  it("真偽値のみを許すJSON Schemaオブジェクトを返す", () => {
    const constraint = buildTriageResponseConstraint();

    expect(constraint).toEqual({ type: "boolean" });
  });

  it("メタ情報の$schemaフィールドは含まない(Prompt APIの想定外のため)", () => {
    const constraint = buildTriageResponseConstraint() as Record<string, unknown>;

    expect(constraint.$schema).toBeUndefined();
  });
});
