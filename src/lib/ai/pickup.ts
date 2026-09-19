/**
 * チャット発言1件からGemini Nano(Prompt API)に注目の表現(語句と意味のペア)を
 * 抜き出させるオーケストレーション層。
 *
 * 実際の「ジョブ投入 → JSON 解釈 → スキーマ検証(→ 再試行)」は `structured-prompt.ts` に
 * 共通化しており、ここでは Pick up 固有の前処理・後処理だけを担当する。
 *
 * - `pickUpExpressions`: `pickup-filter.ts` で emote・@メンション・URL を除いた本文を
 *   `runStructuredPrompt` に渡し、emote 名などの決定的に除外できる語句を落としたうえで、
 *   各語句が LLM に渡した本文に登場することを単語の境界で照合してから返す。本文に無い語句(モデルが
 *   解説言語の語や言い換えを「原文の語句」として返したもの)はその語句だけを落とし、残りの語句は返す
 *   (issue #120)。残る語句が1件も無い場合だけ失敗として扱い、再試行しない。
 *   emote だけの発言のように渡す本文が空になる場合は LLM を呼ばず、空の結果を返す(issue #26)。
 *   `findCandidates` を渡すとハイブリッド抽出(issue #116)になる: 表現リストとの照合で本文中に見つかった
 *   候補をユーザープロンプトに注入し、LLM 1回の呼び出しで「候補の採否 + 採用候補の意味 + 候補に無い
 *   自由発見」を返させ、応答を候補集合と決定的に照合して検証する(`verifyTerms`)。
 * - `createPickupBaseSessionFactory`: Pick up 専用のシステムプロンプトを持つベースセッションの生成関数を組み立てる。
 *   翻訳用とはプール(ベースセッション)を分ける前提(issue #15 の方針 (a))。直列キューは共有する(issue #23)
 */
import type { Settings } from "@/lib/settings";
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import { createLlmBaseSessionFactory } from "./llm-provider";
import type { PickupCandidate } from "./pickup-candidates";
import { filterPickupTerms, preparePickupInput } from "./pickup-filter";
import { buildTermExpressionKey } from "./pickup-ordinary-filter";
import { buildPickupSystemPrompt, buildPickupUserPrompt, type StreamContext, type SupportedLanguage } from "./prompts";
import { pickupSchema, type PickupResult, type PickupTerm } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";
import { runStructuredPrompt } from "./structured-prompt";

/**
 * 1回の抽出で LLM に注入する候補の上限件数。候補が多い発言でプロンプトが膨らみ、
 * 小型モデルの採否判断が崩れるのを防ぐ。超過分は本文中の出現順で後ろから切り捨てる。
 *
 * 実チャット評価(issue #117。2配信・各45分・計2,483発言)で確定した値。1発言あたりの候補は最大6件で、
 * 上限8〜12件のどれでも切り捨ては一度も発生しなかったため、安全弁として10件のままとする。
 * 切り捨てが実際には起きないため、優先順位付け(長い表現優先・頻度帯など)は実装していない
 */
export const MAX_INJECTED_PICKUP_CANDIDATES = 10;

/** 候補を注入した抽出で、候補に無い自由発見(discovery)として受け入れる上限件数(issue #112 の決定事項) */
export const MAX_PICKUP_DISCOVERIES = 2;

export interface PickupOptions {
  /** 抽出は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
  /** Twitch IRC の `emotes` タグから得た emote の位置。省略時は emote の除去を行わない */
  emotes?: EmotePosition[];
  /** 結果から落とす名前(表示中の発言者名など)。@ 無しで本文に書かれたユーザー名は LLM が語句として返しやすい */
  excludedNames?: string[];
  /**
   * emote・@メンション・URL を除いた本文から、表現リスト候補を列挙する関数(ハイブリッド抽出。issue #116)。
   * 学ぶ言語ごとの候補生成と、既出管理で抑制中の候補の除外は呼び出し側(`store/pickups.ts`)が
   * この関数の中で済ませる(このモジュールはストアに依存しない)。省略時は候補を注入しない
   */
  findCandidates?: (preparedText: string) => PickupCandidate[];
}

/**
 * 分かち書きをする文字体系(ラテン文字)の文字と数字。原文照合で「語句の端と、その外側の隣接文字が
 * ともにこれに該当する」場合は単語の途中とみなす。日本語のように分かち書きをしない文字は該当しないため、
 * 前後に文字が続いていても単語の途中とは扱わない。結合文字(`\p{M}`)は、NFC で合成済みの1文字にならない
 * アクセント記号がラテン文字の直後に残った場合に、それを単語の一部として扱うために含める
 */
const SPACED_SCRIPT_WORD_CHAR = /[\p{Script=Latin}\p{N}\p{M}]/u;

/**
 * チャット本文から注目の表現を抽出する。
 * `runStructuredPrompt` でスキーマ検証済みの結果を得たあと、決定的な後段フィルタ → 候補集合・本文との照合の順で処理する。
 * 本文に無い語句(モデルが解説言語の語や言い換えを「原文の語句」として返したもの)はその語句だけを落とす。
 * 以前は1件でも本文に無い語句があると発言全体を失敗にしていたが、実チャットでは言い換えの1件のせいで
 * 同じ発言の正当な語句まで失われていたため、語句単位で落とす方式に変えた(issue #120)。
 * ただし、落とした結果として語句が1件も残らない場合はエラーを投げる(モデルの応答が丸ごと的外れである
 * ことを、空の結果として握り潰さないため)。
 * 解説言語の発言(逆方向)は、翻訳パイプラインが生成した学ぶ言語の訳文を本文としてこの関数で抽出する
 * (issue #68。`store/pickups.ts` の runReverseJob を参照)。
 * 原文照合は自由発見にだけ課す(採用された候補は本文から生成した候補集合との照合で検証済みのため)。
 */
export async function pickUpExpressions(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: PickupOptions = {},
): Promise<PickupResult> {
  const prepared = preparePickupInput(chatMessageText, options.emotes ?? []);
  if (prepared.text === "") {
    return { terms: [] };
  }

  const candidates = (options.findCandidates?.(prepared.text) ?? []).slice(0, MAX_INJECTED_PICKUP_CANDIDATES);
  const result = await runStructuredPrompt(sessionPool, {
    userPrompt: buildPickupUserPrompt(
      prepared.text,
      candidates.map((candidate) => candidate.term),
      MAX_PICKUP_DISCOVERIES,
    ),
    schema: pickupSchema,
    priority: options.priority ?? "low",
    signal: options.signal,
  });

  const filtered = filterPickupTerms(result.terms, prepared, options.excludedNames ?? []);
  const { terms, unknownTerms } = verifyTerms(filtered, candidates, normalizeForSourceMatch(prepared.text));
  if (terms.length === 0 && unknownTerms.length > 0) {
    throw new Error(`The Prompt API returned a term that does not appear in the message: ${unknownTerms[0].term}`);
  }
  return { terms };
}

/**
 * 原文照合のための正規化。大文字小文字を区別せず、アクセント付き文字の表現方法の違い
 * (合成済みの1文字 / 基底文字 + 結合文字)を NFC に揃える
 */
function normalizeForSourceMatch(text: string): string {
  return text.normalize("NFC").toLowerCase();
}

/**
 * 語句が本文に、単語の境界で区切られた形で登場するかを判定する。
 * 照合は大文字小文字を区別せず、語句の前後の空白は無視する(「W」を「w」として返す程度の揺れは原文の語句とみなす)。
 * 単純な部分文字列の一致では、短い語句が別の単語の一部("wow" の中の "w")に一致してしまうため、
 * 一致箇所の両端が単語の途中でないことを確かめる。本文中のどこか1箇所でも条件を満たせば登場とみなす。
 *
 * @param normalizedText `normalizeForSourceMatch` で正規化済みの本文
 */
function appearsInText(normalizedText: string, term: string): boolean {
  const needle = normalizeForSourceMatch(term.trim());
  if (needle === "") return false;

  // 語句の端の文字と、その外側の隣接文字がともに分かち書きの文字なら単語の途中
  const isInsideWord = (edgeChar: string, outerChar: string | undefined) =>
    outerChar !== undefined && SPACED_SCRIPT_WORD_CHAR.test(edgeChar) && SPACED_SCRIPT_WORD_CHAR.test(outerChar);

  for (
    let index = normalizedText.indexOf(needle);
    index !== -1;
    index = normalizedText.indexOf(needle, index + 1)
  ) {
    const end = index + needle.length;
    const startsInsideWord = isInsideWord(needle[0], normalizedText[index - 1]);
    const endsInsideWord = isInsideWord(needle[needle.length - 1], normalizedText[end]);
    if (!startsInsideWord && !endsInsideWord) return true;
  }
  return false;
}

/**
 * LLM が返した語句を、注入した候補集合と本文に対して決定的に照合して仕分ける(ハイブリッド抽出。issue #116)。
 *
 * - 候補との照合は ID ではなく語句の文字列をレンマ正規化した表現キー(`buildTermExpressionKey`)で行う
 *   (小型モデルの ID ずれ・幻覚 ID を避けるため)。候補の採用か自由発見かは LLM の自己申告ではなく
 *   この照合結果で決める
 * - 候補に一致した語句は採用とみなし、語句を候補の表面形(本文中の形)に置き換える。LLM が
 *   語形違い("picked up" を "pick up")で返しても本文どおりに表示するため。同じ候補の重複は最初の1件だけ残す
 * - 候補に一致しない語句は自由発見として原文照合(`appearsInText`)を課し、本文に無い語句は落とす(issue #120)。
 *   落とした語句は自由発見の上限件数に数えない
 * - 本文にある自由発見は、先頭から `MAX_PICKUP_DISCOVERIES` 件まで残す。
 *   上限は候補を注入した(= プロンプトで上限を伝えた)場合にだけ課し、候補が無い発言では従来どおり全件を残す
 * - LLM が返さなかった候補は文脈での不採用であり、失敗として扱わない(結果に含めないだけ)
 *
 * @param normalizedText `normalizeForSourceMatch` で正規化済みの本文(自由発見の原文照合に使う)
 * @returns `terms` は LLM が返した順序を保った仕分け後の全語句、`unknownTerms` は本文に無いため落とした語句
 *   (呼び出し側が「1件も残らなかった」場合の失敗判定に使う)
 */
function verifyTerms(
  terms: PickupTerm[],
  candidates: PickupCandidate[],
  normalizedText: string,
): { terms: PickupTerm[]; unknownTerms: PickupTerm[] } {
  const maxDiscoveries = candidates.length === 0 ? Infinity : MAX_PICKUP_DISCOVERIES;
  const candidatesByKey = new Map(candidates.map((candidate) => [candidate.expressionKey, candidate]));
  const adoptedKeys = new Set<string>();
  const verified: PickupTerm[] = [];
  const unknownTerms: PickupTerm[] = [];
  let discoveryCount = 0;
  for (const item of terms) {
    const key = buildTermExpressionKey(item.term);
    const candidate = candidatesByKey.get(key);
    if (candidate !== undefined) {
      if (adoptedKeys.has(key)) continue;
      adoptedKeys.add(key);
      verified.push({ term: candidate.term, meaning: item.meaning });
    } else if (!appearsInText(normalizedText, item.term)) {
      unknownTerms.push(item);
    } else if (discoveryCount < maxDiscoveries) {
      discoveryCount += 1;
      verified.push(item);
    }
  }
  return { terms: verified, unknownTerms };
}

/**
 * 設定(LLM プロバイダ)と学ぶ言語・意味を書く言語のペアから、
 * Pick up 専用の `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `streamContext`(配信タイトル・カテゴリ)を渡すとシステムプロンプトの末尾に
 * 配信の文脈として追記される(issue #54)。null / 省略時は文脈なしの現行プロンプト
 */
export function createPickupBaseSessionFactory(
  settings: Settings,
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  streamContext?: StreamContext | null,
): () => Promise<PromptSessionLike> {
  return createLlmBaseSessionFactory(
    settings,
    (target, explain) => buildPickupSystemPrompt(target, explain, streamContext),
    targetLang,
    explainLang,
  );
}
