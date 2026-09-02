/**
 * チャット発言1件からGemini Nano(Prompt API)に注目の表現(語句と意味のペア)を
 * 抜き出させるオーケストレーション層。
 *
 * 実際の「ジョブ投入 → JSON 解釈 → スキーマ検証(→ 再試行)」は `structured-prompt.ts` に
 * 共通化しており、ここでは Pick up 固有の前処理・後処理だけを担当する。
 *
 * - `pickUpExpressions`: `pickup-filter.ts` で emote・@メンション・URL を除いた本文を
 *   `runStructuredPrompt` に渡し、emote 名などの決定的に除外できる語句を落としたうえで、
 *   各語句が LLM に渡した本文に登場することを照合してから返す(モデルが解説言語の語や言い換えを
 *   「原文の語句」として返した応答は失敗として扱い、再試行しない)。
 *   emote だけの発言のように渡す本文が空になる場合は LLM を呼ばず、空の結果を返す(issue #26)。
 * - `createPickupBaseSessionFactory`: Pick up 専用のシステムプロンプトを持つベースセッションの生成関数を組み立てる。
 *   翻訳用とはプール(ベースセッション)を分ける前提(issue #15 の方針 (a))。直列キューは共有する(issue #23)
 */
import type { Settings } from "@/lib/settings";
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import { createLlmBaseSessionFactory } from "./llm-provider";
import { filterPickupTerms, preparePickupInput } from "./pickup-filter";
import { buildPickupSystemPrompt, buildPickupUserPrompt, type StreamContext, type SupportedLanguage } from "./prompts";
import { pickupSchema, type PickupResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";
import { runStructuredPrompt } from "./structured-prompt";

export interface PickupOptions {
  /** 抽出は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
  /** Twitch IRC の `emotes` タグから得た emote の位置。省略時は emote の除去を行わない */
  emotes?: EmotePosition[];
  /** 結果から落とす名前(表示中の発言者名など)。@ 無しで本文に書かれたユーザー名は LLM が語句として返しやすい */
  excludedNames?: string[];
}

/**
 * チャット本文から注目の表現を抽出する。
 * `runStructuredPrompt` でスキーマ検証済みの結果を得たあと、決定的な後段フィルタ → 本文との照合の順で処理し、
 * 照合に失敗した場合はエラーを投げる。照合は大文字小文字を区別しない
 * (「W」を「w」として返す程度の揺れは原文の語句とみなす)。
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

  const result = await runStructuredPrompt(sessionPool, {
    userPrompt: buildPickupUserPrompt(prepared.text),
    schema: pickupSchema,
    priority: options.priority ?? "low",
    signal: options.signal,
  });

  const terms = filterPickupTerms(result.terms, prepared, options.excludedNames ?? []);
  const normalizedText = prepared.text.toLowerCase();
  const unknownTerm = terms.find((term) => !normalizedText.includes(term.term.toLowerCase()));
  if (unknownTerm) {
    throw new Error(`The Prompt API returned a term that does not appear in the message: ${unknownTerm.term}`);
  }
  return { terms };
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
