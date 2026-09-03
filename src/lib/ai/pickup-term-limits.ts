/**
 * 自動 Pick up の語句の語数上限(issue #104)。
 *
 * 実行時フィルタ(`pickup-filter.ts` の `filterLongPhraseTerms`)と、表現リストの生成スクリプト
 * (`scripts/generate-pickup-filter-data.mjs` の枝刈り条件)の両方から参照するため、
 * 依存の無い専用モジュールに切り出している(スクリプトは Node.js の型ストリッピングで
 * このファイルを直接 import するため、JSON import 等を含むモジュールには置けない)。
 *
 * 値の根拠: Wiktionary 由来の表現リストの語数分布では6語以下が大半を占め、7語以上の表現は
 * 約280件と少ない。7語以上の語句は表現リストとの照合で救済できるため、それ以外は
 * 「発言の文まるごとの抽出」とみなして落とす。
 */

/** Pick up の語句として許容する最大語数。これを超え、かつ表現リストに無い語句は落とす */
export const MAX_PICKUP_TERM_WORD_COUNT = 6;
