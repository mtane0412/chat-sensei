/**
 * チャット発言1件をGemini Nano(Prompt API)に翻訳させるオーケストレーション層。
 *
 * 実際の「ジョブ投入 → JSON 解釈 → スキーマ検証(→ 再試行)」は `structured-prompt.ts` に
 * 共通化しており、ここでは翻訳専用のプロンプト・スキーマを渡すだけにする。
 *
 * - `translateChatMessage`: 翻訳用ユーザープロンプトと `translationSchema` で `runStructuredPrompt` を呼ぶ
 * - `createTranslateBaseSessionFactory`: 翻訳専用のシステムプロンプトを持つベースセッションの生成関数を組み立てる。
 *   Pick up 用とはプール(ベースセッション)を分ける前提(issue #15 の方針 (a))。直列キューは共有する(issue #23)
 */
import type { Settings } from "@/lib/settings";
import { createLlmBaseSessionFactory } from "./llm-provider";
import { buildTranslateSystemPrompt, buildTranslateUserPrompt, type StreamContext, type SupportedLanguage } from "./prompts";
import { translationSchema, type TranslationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";
import { runStructuredPrompt } from "./structured-prompt";

export interface TranslateOptions {
  /** 翻訳は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
  /** 本文中で emote を置き換えたプレースホルダ。指定した場合だけユーザープロンプトにその説明を付ける(issue #44) */
  placeholderTokens?: readonly string[];
}

/** チャット本文の翻訳を生成する。応答の解釈・検証・再試行の方針は `runStructuredPrompt` に従う */
export async function translateChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: TranslateOptions = {},
): Promise<TranslationResult> {
  return runStructuredPrompt(sessionPool, {
    userPrompt: buildTranslateUserPrompt(chatMessageText, options.placeholderTokens ?? []),
    schema: translationSchema,
    priority: options.priority ?? "low",
    signal: options.signal,
  });
}

/**
 * 設定(LLM プロバイダ)と学ぶ言語・訳文の言語のペアから、
 * 翻訳専用の `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `streamContext`(配信タイトル・カテゴリ)を渡すとシステムプロンプトの末尾に
 * 配信の文脈として追記される(issue #54)。null / 省略時は文脈なしの現行プロンプト
 */
export function createTranslateBaseSessionFactory(
  settings: Settings,
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  streamContext?: StreamContext | null,
): () => Promise<PromptSessionLike> {
  return createLlmBaseSessionFactory(
    settings,
    (target, explain) => buildTranslateSystemPrompt(target, explain, streamContext),
    targetLang,
    explainLang,
  );
}
