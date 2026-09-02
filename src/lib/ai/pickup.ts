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
import type { z } from "zod";
import type { Settings } from "@/lib/settings";
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import { createLlmBaseSessionFactory } from "./llm-provider";
import { filterPickupTerms, preparePickupInput, type PreparedPickupInput } from "./pickup-filter";
import {
  buildPickupSystemPrompt,
  buildPickupUserPrompt,
  buildReversePickupSystemPrompt,
  buildReversePickupUserPrompt,
  type StreamContext,
  type SupportedLanguage,
} from "./prompts";
import { pickupSchema, reversePickupSchema, type PickupResult, type PickupTerm } from "./schemas";
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

/** 順方向・逆方向で共通の「足切り → 構造化生成 → 決定的フィルタ → 照合」の指定。両公開関数の差分だけを持つ */
interface PickupExtractionSpec<TResult extends PickupResult> {
  /** LLM に渡すユーザープロンプトの組み立て */
  buildUserPrompt: (text: string) => string;
  /** 応答の検証スキーマ(`terms` を含むこと) */
  schema: z.ZodType<TResult>;
  /** 語句の照合対象。順方向は原文(prepared.text)、逆方向は応答内の訳文 */
  getMatchTarget: (prepared: PreparedPickupInput, result: TResult) => { text: string; label: string };
  /**
   * 照合に失敗した語句の扱い。順方向は決定的な原文への照合なので応答全体を失敗(throw)にするが、
   * 逆方向は訳文・語句とも生成物で表記が揺れやすいため、その語句だけを落とす(drop)
   */
  onMismatch: "throw" | "drop";
}

/** 順方向・逆方向の Pick up の共通処理。照合は大文字小文字を区別せず、語句の前後の空白は無視する */
async function extractPickupTerms<TResult extends PickupResult>(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: PickupOptions,
  spec: PickupExtractionSpec<TResult>,
): Promise<PickupResult> {
  const prepared = preparePickupInput(chatMessageText, options.emotes ?? []);
  if (prepared.text === "") {
    return { terms: [] };
  }

  const result = await runStructuredPrompt(sessionPool, {
    userPrompt: spec.buildUserPrompt(prepared.text),
    schema: spec.schema,
    priority: options.priority ?? "low",
    signal: options.signal,
  });

  const terms = filterPickupTerms(result.terms, prepared, options.excludedNames ?? []);
  const matchTarget = spec.getMatchTarget(prepared, result);
  const normalizedTarget = matchTarget.text.toLowerCase();
  const appearsInTarget = (term: PickupTerm) => normalizedTarget.includes(term.term.trim().toLowerCase());

  if (spec.onMismatch === "drop") {
    return { terms: terms.filter(appearsInTarget) };
  }
  const unknownTerm = terms.find((term) => !appearsInTarget(term));
  if (unknownTerm) {
    throw new Error(`The Prompt API returned a term that does not appear in the ${matchTarget.label}: ${unknownTerm.term}`);
  }
  return { terms };
}

/**
 * チャット本文から注目の表現を抽出する(順方向)。
 * `runStructuredPrompt` でスキーマ検証済みの結果を得たあと、決定的な後段フィルタ → 原文との照合の順で処理し、
 * 照合に失敗した場合はエラーを投げる(モデルが解説言語の語や言い換えを「原文の語句」として返した応答を表示しない)。
 */
export async function pickUpExpressions(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: PickupOptions = {},
): Promise<PickupResult> {
  return extractPickupTerms(sessionPool, chatMessageText, options, {
    buildUserPrompt: buildPickupUserPrompt,
    schema: pickupSchema,
    getMatchTarget: (prepared) => ({ text: prepared.text, label: "message" }),
    onMismatch: "throw",
  });
}

/**
 * 解説言語のチャット本文を学ぶ言語へ翻訳させ、その訳文から注目の表現を抽出する(逆方向 Pick up)。
 * 翻訳と抽出を 1 回の構造化生成(`reversePickupSchema`)で行い、訳文(`translation`)は
 * 語句の照合にのみ使って結果には含めない(翻訳列の表示は翻訳パイプラインが別途生成する)。
 * 訳文・語句とも生成物で表記が揺れやすいため、訳文に登場しない語句はその語句だけを落とす。
 */
export async function pickUpFromReverseTranslation(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: PickupOptions = {},
): Promise<PickupResult> {
  return extractPickupTerms(sessionPool, chatMessageText, options, {
    buildUserPrompt: buildReversePickupUserPrompt,
    schema: reversePickupSchema,
    getMatchTarget: (_prepared, result) => ({ text: result.translation, label: "translation" }),
    onMismatch: "drop",
  });
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

/**
 * 設定(LLM プロバイダ)と学ぶ言語・解説言語のペアから、逆方向 Pick up 専用の
 * `SessionPool` に渡すベースセッション生成関数を組み立てる。入力は解説言語の発言、
 * 出力は学ぶ言語の訳文(translation)と解説言語の意味(meaning)の混在になるため、
 * `expectedInputs`・`expectedOutputs` とも両言語を宣言する。
 * `streamContext` の扱いは順方向(issue #54)と同じ。
 */
export function createReversePickupBaseSessionFactory(
  settings: Settings,
  learningLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  streamContext?: StreamContext | null,
): () => Promise<PromptSessionLike> {
  return createLlmBaseSessionFactory(
    settings,
    (target, explain) => buildReversePickupSystemPrompt(target, explain, streamContext),
    learningLang,
    explainLang,
    [learningLang, explainLang],
  );
}
