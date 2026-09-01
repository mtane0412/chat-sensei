/**
 * チャット発言1件をGemini Nano(Prompt API)に解説させるオーケストレーション層。
 *
 * 解説パネルは UI から撤去済みで、現在は画面から呼び出されていない(翻訳列・Pick up 列のみ表示する)。
 * 実際の「ジョブ投入 → JSON 解釈 → スキーマ検証(→ 再試行)」は `structured-prompt.ts` に
 * 共通化しており、ここでは解説専用のプロンプト・スキーマを渡すだけにする。
 *
 * - `explainChatMessage`: 解説用ユーザープロンプトと `explanationSchema` で `runStructuredPrompt` を呼ぶ
 * - `createExplainBaseSessionFactory`: 解説専用のシステムプロンプトを持つベースセッションの生成関数を組み立てる
 */
import { buildExplainSystemPrompt, buildExplainUserPrompt, type SupportedLanguage } from "./prompts";
import { explanationSchema, type ExplanationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";
import { createBaseSessionFactory, runStructuredPrompt } from "./structured-prompt";

export interface ExplainOptions {
  /** 利用者の明示的な操作(既定: high)かバックグラウンド生成(low)か */
  priority?: JobPriority;
  signal?: AbortSignal;
}

/** チャット本文の解説を生成する。応答の解釈・検証・再試行の方針は `runStructuredPrompt` に従う */
export async function explainChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: ExplainOptions = {},
): Promise<ExplanationResult> {
  return runStructuredPrompt(sessionPool, {
    userPrompt: buildExplainUserPrompt(chatMessageText),
    schema: explanationSchema,
    priority: options.priority ?? "high",
    signal: options.signal,
  });
}

/** 学ぶ言語・解説言語のペアから、解説専用の `SessionPool` に渡すベースセッション生成関数を組み立てる */
export function createExplainBaseSessionFactory(
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return createBaseSessionFactory(buildExplainSystemPrompt, targetLang, explainLang);
}
