/**
 * チャット発言1件をGemini Nano(Prompt API)に解説させるオーケストレーション層。
 *
 * - `explainChatMessage`: `SessionPool` にジョブを積み、返ってきたJSON文字列を
 *   `explanationSchema` で検証してから返す。自由文をパースする脆い処理は行わない。
 * - `createExplainBaseSessionFactory`: `SessionPool` に渡すベースセッションの
 *   生成関数を、学ぶ言語(targetLang)・解説言語(explainLang)から組み立てる。
 *   実際に `window.LanguageModel` を呼び出す唯一の場所。
 */
import { buildExplainSystemPrompt, buildExplainUserPrompt, type SupportedLanguage } from "./prompts";
import { buildExplanationResponseConstraint, explanationSchema, type ExplanationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";

export interface ExplainOptions {
  /** 手動ピック(既定: high)か自動抽出(low)か */
  priority?: JobPriority;
  signal?: AbortSignal;
}

/**
 * チャット本文の解説を生成する。
 * Prompt API の応答は必ず JSON 文字列として返るため、`JSON.parse` → `explanationSchema.parse`
 * の順で検証し、いずれかに失敗した場合はエラーを投げる(あいまいな自由文解析へのフォールバックはしない)。
 */
export async function explainChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: ExplainOptions = {},
): Promise<ExplanationResult> {
  const priority = options.priority ?? "high";

  const raw = await sessionPool.enqueue(
    priority,
    (session) =>
      session.prompt(buildExplainUserPrompt(chatMessageText), {
        responseConstraint: buildExplanationResponseConstraint(),
      }),
    options.signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Prompt APIの応答をJSONとして解釈できませんでした: ${raw}`, { cause: error });
  }

  return explanationSchema.parse(parsed);
}

/**
 * 学ぶ言語・解説言語のペアから、`SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `window.LanguageModel` は診断済み(availability.ts)である前提で呼び出す。
 */
export function createExplainBaseSessionFactory(
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return async () =>
    LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildExplainSystemPrompt(targetLang, explainLang) }],
      expectedInputs: [{ type: "text", languages: [targetLang, explainLang] }],
      expectedOutputs: [{ type: "text", languages: [explainLang] }],
    });
}
