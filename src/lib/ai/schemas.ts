/**
 * Gemini Nano(Prompt API)に生成させる「チャット翻訳」「Pick up(注目の表現)」「チャット解説」の
 * 構造を定義するスキーマ。
 *
 * zod スキーマを唯一の定義源とし、(1) Prompt API の `responseConstraint` に渡す
 * JSON Schema(`toResponseConstraint`)、(2) モデルが返した JSON 文字列を実行時に検証する
 * バリデータ、の両方をここから導出する。自由文をパースする脆い処理を避けるための設計。
 *
 * 解説(`explanationSchema`)は UI からは撤去済みで、現在は翻訳と Pick up のみが画面に表示される。
 */
import { z } from "zod";

/**
 * zod スキーマから `session.prompt(text, { responseConstraint })` にそのまま渡せる JSON Schema を組み立てる。
 * `$schema` メタ情報は Prompt API が想定しない可能性があるため取り除く。
 */
export function toResponseConstraint(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  delete jsonSchema.$schema;
  return jsonSchema;
}

/**
 * 中央列「翻訳」に表示する翻訳結果。訳文のみの最小構造とし、
 * 語句の列挙や難易度などの解説向け情報は含めない。
 */
export const translationSchema = z.object({
  /** 解説言語での自然な訳 */
  translation: z.string(),
});

export type TranslationResult = z.infer<typeof translationSchema>;

/**
 * 右列「Pick up」に表示する、注目の表現(語句と意味のペア)の一覧。
 * 学習者が意味を推測しにくい特殊な表現(スラング・略語・イディオム・ミーム)だけを対象とし、
 * 訳文・直訳・分類・難易度などの解説向け情報は含めない。
 */
export const pickupTermSchema = z.object({
  /** 元のチャット本文中に登場する語句・フレーズそのもの(原文との照合は `pickup.ts` が行う) */
  term: z.string().min(1),
  /** 解説言語での短い意味 */
  meaning: z.string().min(1),
});

export const pickupSchema = z.object({
  /** 該当する表現が無い場合は空配列 */
  terms: z.array(pickupTermSchema),
});

export type PickupTerm = z.infer<typeof pickupTermSchema>;
export type PickupResult = z.infer<typeof pickupSchema>;

/**
 * 逆方向 Pick up(解説言語の発言を学ぶ言語へ翻訳し、その訳文から注目の表現を抽出する)の結果。
 * 語句(`terms[].term`)は原文ではなく訳文(`translation`)に登場する文字列であることを
 * `pickup.ts` が照合するため、訳文も応答に含めさせる(1回の生成で翻訳と抽出の両方を得る)。
 * 訳文が空だと照合ができないため空文字は拒否する。
 */
export const reversePickupSchema = z.object({
  /** 学ぶ言語での訳文(語句の照合にのみ使い、画面には表示しない) */
  translation: z.string().min(1),
  /** 訳文から抽出した表現。該当が無い場合は空配列 */
  terms: z.array(pickupTermSchema),
});

export type ReversePickupResult = z.infer<typeof reversePickupSchema>;

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

/** 「チャット解説」の結果。UI からは撤去済みだが、`explain.ts` が利用する定義として残している */
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
