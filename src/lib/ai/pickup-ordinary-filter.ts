/**
 * 自動 Pick up の後段に置く、普通の単語・字義通りの句を落とす決定的フィルタ(issue #95)。
 *
 * Gemini Nano はプロンプトで「普通の単語を含めない」と指示しても "rare" / "main quests" のような
 * 普通の語句を「特殊な表現」として返す(issue #26 / #30 / #33 と同じ傾向)。頻度ベースの拒否リスト
 * だけでは "give up" のような「高頻度語だけで構成される句動詞・イディオム」まで落としてしまうため、
 * 表現リストを併用するハイブリッド方式を採る:
 *
 * - 1語の語句: 高頻度語リスト(NGSL 1.2 約2800レンマ + 手動補完語 + 字幕頻度リスト第2層)にあれば落とす。
 *   第2層(issue #99)は OpenSubtitles 由来の頻度上位語から Wiktionary スラング系カテゴリの1語と
 *   Twitch特有の意味を持つ語を除いたもので、NGSL 圏外の普通語("flavour" / "paradise")を捕捉する。
 *   リストに無いスラング("lol" / "malding")や Twitch 用語("raid" / "emote")は残る。
 *   "sooo" のような伸ばし字は同一文字の3連続以上を潰した形でも照合して落とす(issue #97)
 * - 複数語の語句: 表現リスト(Wiktionary の句動詞・イディオム・スラング + 手動補完の定型表現)に
 *   レンマ正規化して一致すれば残す。リスト外で全語が高頻度なら落とす("main quests")。
 *   非高頻度語を1語でも含めば残す(リストに無い新しいミーム表現の偽陰性を減らす)
 *
 * 照合キーの正規化(語形の揺れの吸収)と語の分割は `stem.ts` に共通化し、
 * リスト側・語句側の両方を同じ関数で正規化してから照合する。データファイルは
 * `scripts/generate-pickup-filter-data.mjs` で生成した同梱 JSON を読む(実行時にネットワークへは出ない)。
 *
 * 対象言語は当面 en のみ。他言語(es / de / fr / ja)はリスト未整備のため何も落とさない
 * (issue #95 の留意点)。
 */
import enExpressionList from "./data/en-expression-list.json";
import enFrequentWords from "./data/en-frequent-words.json";
import type { SupportedLanguage } from "./prompts";
import type { PickupTerm } from "./schemas";
import { collapseElongatedLetters, splitIntoMatchWords, stemForMatch } from "./stem";

/**
 * Wiktionary のカテゴリに無い、学習価値のある定型表現の手動補完リスト。
 * 定型接続表現(issue #95 の決定事項「"Even though" のような基礎的だが学習価値のある定型表現」)、
 * プロンプトの例示にも使っているコロケーション、Wiktionary 未収載の新しいミーム表現を収録する。
 * 全語が高頻度語で構成される複数語表現だけがこのリストを必要とする
 * (非高頻度語を含む表現はリスト照合の前に「残す」判定になるため)。
 */
export const CURATED_EXPRESSIONS: readonly string[] = [
  // 定型接続表現
  "even though",
  "even if",
  "as though",
  "as well as",
  "no matter what",
  "no matter how",
  "at least",
  "at most",
  "sort of",
  // プロンプトの例示に使っているコロケーション(prompts.ts の PICKUP_MULTIWORD_EXAMPLES)
  "put effort into",
  // Wiktionary 未収載の新しいミーム表現(観測し次第追記する)
  "let him cook",
  "let her cook",
  "on god",
];

/** 高頻度語の照合キー集合。NGSL のレンマ・手動補完語・字幕頻度リスト(第2層)を `stemForMatch` で正規化して持つ */
const FREQUENT_STEMS: ReadonlySet<string> = new Set(
  [...enFrequentWords.ngslWords, ...enFrequentWords.supplementaryWords, ...enFrequentWords.subtitleWords].map(
    stemForMatch,
  ),
);

/**
 * 語が高頻度語かを判定する。`sooo` のような伸ばし字が頻度照合を素通りしないよう、
 * 元の形に加えて同一文字の3連続以上を1文字に潰した形(`sooo` → `so`)でも照合する(issue #97)。
 * - 潰した形だけで判定すると誤変換で衝突しうるため、「どちらかが高頻度語に一致したら普通の語」とみなす
 * - 2文字連続は `loot` / `yeet` / `weeb` のような正当なスラングを壊すため潰さない(`collapseElongatedLetters` 参照)
 * - 潰しの後方参照が大小文字を区別するため、混在ケース(`SOoo`)に備えて先に小文字化する
 */
function isFrequentWord(word: string): boolean {
  return (
    FREQUENT_STEMS.has(stemForMatch(word)) ||
    FREQUENT_STEMS.has(stemForMatch(collapseElongatedLetters(word.toLowerCase())))
  );
}

/** 表現の照合キーを組み立てる。語ごとに正規化してから空白1つで連結する */
function buildExpressionKey(words: string[]): string {
  return words.map(stemForMatch).join(" ");
}

/**
 * 語句の表現キー(レンマ正規化キー)を組み立てる。大文字・語形変化・前後の記号の揺れを吸収し、
 * "picked up" と "pick up" を同じキーに集約する。既出管理(issue #108。`store/pickup-encounters.ts`)が
 * 遭遇記録のキーとして流用する。
 */
export function buildTermExpressionKey(term: string): string {
  return buildExpressionKey(splitIntoMatchWords(term));
}

/** 表現リストの照合キー集合。Wiktionary 由来のリストと手動補完リストを正規化して持つ */
const EXPRESSION_KEYS: ReadonlySet<string> = new Set(
  [...enExpressionList.expressions, ...CURATED_EXPRESSIONS].map((expression) =>
    buildExpressionKey(splitIntoMatchWords(expression)),
  ),
);

/**
 * 語句が表現リスト(Wiktionary 由来 + 手動補完)に一致するかを判定する。
 * リスト側・語句側とも同じレンマ正規化(`stemForMatch`)を通すため、大文字・語形変化・
 * 前後の記号の揺れがあっても一致する。issue #100 / #104 のフィルタ(固有名詞・疑問文まるごと・
 * 語数上限超の足切り)が正当な定型表現を誤って落とさないための救済判定に使う。
 *
 * 注意: 表現リストは「全語が高頻度語で構成される表現、または語数が上限
 * (`pickup-term-limits.ts`)超の表現」に枝刈りして生成している
 * (`scripts/generate-pickup-filter-data.mjs`)ため、"make a mountain out of a molehill" のような
 * 語数上限超のイディオムには非高頻度語を含んでいても一致するが、語数上限以下で非高頻度語を含む
 * イディオムには一致しない。
 */
export function isListedExpression(term: string): boolean {
  return EXPRESSION_KEYS.has(buildExpressionKey(splitIntoMatchWords(term)));
}

/**
 * 普通の単語・字義通りの句と決定的に判別できる語句を落とす。
 * 学ぶ言語が en 以外の場合はリスト未整備のため何も落とさない。
 */
export function filterOrdinaryTerms(terms: PickupTerm[], learningLang: SupportedLanguage): PickupTerm[] {
  if (learningLang !== "en") return terms;
  return terms.filter((item) => {
    const words = splitIntoMatchWords(item.term);
    if (words.length === 0) return true;
    if (words.length === 1) {
      return !isFrequentWord(words[0]);
    }
    if (EXPRESSION_KEYS.has(buildExpressionKey(words))) return true;
    return !words.every(isFrequentWord);
  });
}
