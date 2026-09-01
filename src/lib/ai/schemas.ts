/**
 * Gemini Nano(Prompt API)に生成させる「チャット解説」「チャット翻訳」の構造を定義するスキーマ。
 *
 * zod スキーマを唯一の定義源とし、(1) Prompt API の `responseConstraint` に渡す
 * JSON Schema、(2) モデルが返した JSON 文字列を実行時に検証するバリデータ、
 * の両方をここから導出する。自由文をパースする脆い処理を避けるための設計。
 */
import { z } from "zod";

/** 解説対象の語句・フレーズの分類 */
export const EXPLANATION_ITEM_KINDS = ["slang", "abbreviation", "idiom", "emote", "grammar", "word"] as const;

export const explanationItemSchema = z.object({
  /** 元のチャット本文中に登場する語句・フレーズそのもの */
  term: z.string(),
  kind: z.enum(EXPLANATION_ITEM_KINDS),
  /** 解説言語での意味 */
  meaning: z.string(),
  /** 使われ方についての一言メモ(ニュアンス・使用シーンなど) */
  note: z.string(),
});

export const explanationSchema = z.object({
  /** 解説言語での自然な訳 */
  translation: z.string(),
  /** 直訳 */
  literal: z.string(),
  items: z.array(explanationItemSchema),
  /** 学習者にとっての難易度(1: 易しい 〜 5: 難しい) */
  difficulty: z.number().int().min(1).max(5),
});

export type ExplanationItemKind = (typeof EXPLANATION_ITEM_KINDS)[number];
export type ExplanationItem = z.infer<typeof explanationItemSchema>;
export type ExplanationResult = z.infer<typeof explanationSchema>;

/**
 * `session.prompt(text, { responseConstraint })` にそのまま渡せる JSON Schema を組み立てる。
 * `$schema` メタ情報は Prompt API が想定しない可能性があるため取り除く。
 */
export function buildExplanationResponseConstraint(): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(explanationSchema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * 中央列「翻訳」に表示する翻訳結果。訳文のみの最小構造とし、
 * 語句の列挙や難易度などの解説向け情報は含めない(それらは `explanationSchema` の責務)。
 */
export const translationSchema = z.object({
  /** 解説言語での自然な訳 */
  translation: z.string(),
});

export type TranslationResult = z.infer<typeof translationSchema>;

/**
 * 翻訳用に `session.prompt(text, { responseConstraint })` へそのまま渡せる JSON Schema を組み立てる。
 * `$schema` メタ情報は Prompt API が想定しない可能性があるため取り除く。
 */
export function buildTranslationResponseConstraint(): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(translationSchema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}
