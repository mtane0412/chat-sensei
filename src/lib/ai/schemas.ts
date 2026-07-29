/**
 * Gemini Nano(Prompt API)に生成させる「チャット解説」の構造を定義するスキーマ。
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
 * triage(自動抽出パイプラインにおける学習価値判定)の応答スキーマ。
 * `explainChatMessage` と同様、`JSON.parse` した Prompt API の応答をここで検証する。
 */
export const triageResultSchema = z.boolean();

/**
 * triage用の `responseConstraint`(真偽値のみを許すJSON Schema)を組み立てる。
 * `buildExplanationResponseConstraint` と同じく `$schema` メタ情報は取り除く。
 */
export function buildTriageResponseConstraint(): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(triageResultSchema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}
