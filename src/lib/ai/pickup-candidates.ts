/**
 * 表現リストによる決定的な候補生成器(issue #115 / 親 #112)。
 *
 * チャット本文を `stem.ts` の `splitIntoMatchWords` / `stemForMatch` で正規化し、
 * 表現リスト(Wiktionary 由来の同梱リスト + `CURATED_EXPRESSIONS`)の照合キーに対して
 * 連続 n-gram で照合し、本文中に現れた学習表現の候補を列挙する。完全に決定的・低コスト
 * (Set 照合)で、LLM には依存しない。LLM 抽出だけでは拾い漏れる定型表現("even though" 等)を
 * 候補として救済する第2の経路であり、後続 Phase(issue #116)で LLM への注入・採否に使う。
 *
 * 規則:
 * - 複数語(2語以上)の表現だけを候補にする。1語は高頻度語リスト側の判定(`pickup-ordinary-filter.ts`)
 *   に委ねる
 * - 照合キーはリスト側・本文側とも `buildExpressionKey`(レンマ正規化キー)で組み立て、
 *   語形変化・大文字・前後の記号の揺れを吸収する
 * - 別の候補に完全に包含される候補は最長一致を優先して落とす("no matter what" が
 *   マッチしたら内側の "no matter" は返さない)。部分的に重なるだけの候補は両方残す
 * - 同じ表現キーが本文に複数回現れても候補は1件にまとめる(最初の出現位置の表面形を使う)
 * - 分離型の句動詞("give it up" の "give ... up")はスコープ外(issue #112 の留意点)
 *
 * 対象言語は当面 en のみ。他言語はリスト未整備のため候補を生成しない(issue #95 と同じ制約)。
 */
import enExpressionList from "./data/en-expression-list.json";
import { buildExpressionKey, CURATED_EXPRESSIONS } from "./pickup-ordinary-filter";
import type { SupportedLanguage } from "./prompts";
import { splitIntoMatchWords, stemForMatch } from "./stem";

/** 本文中に見つかった学習表現の候補 */
export interface PickupCandidate {
  /** 本文中の表面形(前後の記号を外した語を空白1つで連結したもの。大文字・語形変化は本文のまま) */
  term: string;
  /** レンマ正規化した照合キー(`buildTermExpressionKey` と同じ規則)。重複排除・既出管理との照合に使う */
  expressionKey: string;
}

/** 本文中のマッチ範囲(語のインデックス。`end` は排他的) */
interface MatchSpan {
  start: number;
  end: number;
}

/**
 * 表現リストから候補生成器(本文 → 候補の配列)を組み立てる。
 * リスト側の表現は照合キーに正規化して Set で持ち、1語の表現は候補対象外として除く。
 * n-gram の最大長はリスト中の最長の表現の語数に合わせる。
 */
export function createExpressionCandidateMatcher(expressions: Iterable<string>): (text: string) => PickupCandidate[] {
  const expressionKeys = new Set<string>();
  let maxWordCount = 0;
  for (const expression of expressions) {
    const words = splitIntoMatchWords(expression);
    if (words.length < 2) continue;
    expressionKeys.add(buildExpressionKey(words));
    maxWordCount = Math.max(maxWordCount, words.length);
  }

  return (text) => {
    const words = splitIntoMatchWords(text);
    // 照合キーの組み立て(buildExpressionKey)と同じく語ごとに正規化する。n-gram ごとの再正規化を
    // 避けるため先に全語を正規化し、部分列の連結でキーを得る(結果は buildExpressionKey と同一)
    const stems = words.map(stemForMatch);

    // 各開始位置で長い n-gram から照合する。同じ開始位置・異なる長さの複数マッチもすべて集め、
    // 包含関係の除去は後段でまとめて行う(開始位置が異なる包含にも対応するため)
    const spans: MatchSpan[] = [];
    for (let start = 0; start < words.length - 1; start++) {
      const longestN = Math.min(maxWordCount, words.length - start);
      for (let n = longestN; n >= 2; n--) {
        if (expressionKeys.has(stems.slice(start, start + n).join(" "))) {
          spans.push({ start, end: start + n });
        }
      }
    }

    // 別のマッチ範囲に完全に包含されるマッチを落とす(最長一致の優先)
    const outermostSpans = spans.filter(
      (span) =>
        !spans.some(
          (other) =>
            other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start,
        ),
    );

    // 同じ表現キーの重複を除き、最初の出現位置の表面形で候補にする
    const seenKeys = new Set<string>();
    const candidates: PickupCandidate[] = [];
    for (const span of outermostSpans) {
      const expressionKey = stems.slice(span.start, span.end).join(" ");
      if (seenKeys.has(expressionKey)) continue;
      seenKeys.add(expressionKey);
      candidates.push({ term: words.slice(span.start, span.end).join(" "), expressionKey });
    }
    return candidates;
  };
}

/** 同梱の表現リスト(Wiktionary 由来 + 手動補完)から組み立てた既定の英語用候補生成器 */
const matchEnglishExpressionCandidates = createExpressionCandidateMatcher([
  ...enExpressionList.expressions,
  ...CURATED_EXPRESSIONS,
]);

/**
 * チャット本文から表現リストに合致する学習表現の候補を列挙する。
 * 学ぶ言語が en 以外の場合はリスト未整備のため候補を生成しない。
 */
export function findExpressionCandidates(text: string, learningLang: SupportedLanguage): PickupCandidate[] {
  if (learningLang !== "en") return [];
  return matchEnglishExpressionCandidates(text);
}
