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
import { buildTranslateSystemPrompt, buildTranslateUserPrompt, type SupportedLanguage } from "./prompts";
import { translationSchema, type TranslationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";
import { createBaseSessionFactory, runStructuredPrompt } from "./structured-prompt";

export interface TranslateOptions {
  /** 翻訳は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
}

/** チャット本文の翻訳を生成する。応答の解釈・検証・再試行の方針は `runStructuredPrompt` に従う */
export async function translateChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: TranslateOptions = {},
): Promise<TranslationResult> {
  return runStructuredPrompt(sessionPool, {
    userPrompt: buildTranslateUserPrompt(chatMessageText),
    schema: translationSchema,
    priority: options.priority ?? "low",
    signal: options.signal,
  });
}

/** 学ぶ言語・訳文の言語のペアから、翻訳専用の `SessionPool` に渡すベースセッション生成関数を組み立てる */
export function createTranslateBaseSessionFactory(
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return createBaseSessionFactory(buildTranslateSystemPrompt, targetLang, explainLang);
}
