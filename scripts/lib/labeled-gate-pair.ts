/**
 * 採否ゲートの比較検証(issue #123)で使う「発言と候補の組」1行分のスキーマ。
 *
 * `scripts/export-gate-pairs.ts` がラベル無しで書き出し、人手で `label` を付けたものを
 * `scripts/evaluate-pickup-gate.ts` が読み込む。本文を含むため、ファイルは gitignore 済みの `eval-data/` にだけ置く。
 */
import { z } from "zod";

export const gatePairSchema = z.object({
  /** 書き出し順の通し番号 */
  id: z.number().int().nonnegative(),
  /** 収集元のログを見分ける名前(ログのファイル名の先頭部分) */
  source: z.string(),
  /** 候補が見つかった発言の本文(`preparePickupInput` 適用後) */
  text: z.string(),
  /** 本文中の表面形 */
  term: z.string(),
  /** 候補の表現キー(`buildTermExpressionKey` と同じ規則) */
  expressionKey: z.string(),
});

export type GatePair = z.infer<typeof gatePairSchema>;

/** 人手でラベルを付けた組。ラベルの意味は `pickup-gate-stats.ts` の `GateLabel` を参照 */
export const labeledGatePairSchema = gatePairSchema.extend({
  label: z.enum(["literal", "basic", "valuable"]),
});

export type LabeledGatePair = z.infer<typeof labeledGatePairSchema>;
