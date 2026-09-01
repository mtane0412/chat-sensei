/**
 * チャット発言1件をGemini Nano(Prompt API)に翻訳させるオーケストレーション層。
 *
 * `explain.ts` と同じ構造で、翻訳専用のプロンプト・スキーマを使う。
 *
 * - `translateChatMessage`: `SessionPool` にジョブを積み、返ってきたJSON文字列を
 *   `translationSchema` で検証してから返す。自由文をパースする脆い処理は行わない。
 * - `createTranslateBaseSessionFactory`: 翻訳専用のシステムプロンプトを持つ
 *   ベースセッションの生成関数を組み立てる。`session-pool.ts` はベースセッションを
 *   1つしか持たないため、翻訳用と解説用でプールを分ける前提(issue #15 の方針 (a))。
 */
import { buildTranslateSystemPrompt, buildTranslateUserPrompt, type SupportedLanguage } from "./prompts";
import { buildTranslationResponseConstraint, translationSchema, type TranslationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";

export interface TranslateOptions {
  /** 翻訳は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
}

/**
 * チャット本文の翻訳を生成する。
 * Prompt API の応答は必ず JSON 文字列として返るため、`JSON.parse` → `translationSchema.parse`
 * の順で検証し、いずれかに失敗した場合はエラーを投げる。
 */
export async function translateChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: TranslateOptions = {},
): Promise<TranslationResult> {
  const priority = options.priority ?? "low";

  const raw = await sessionPool.enqueue(
    priority,
    (session) =>
      session.prompt(buildTranslateUserPrompt(chatMessageText), {
        responseConstraint: buildTranslationResponseConstraint(),
      }),
    options.signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Prompt APIの応答をJSONとして解釈できませんでした: ${raw}`, { cause: error });
  }

  return translationSchema.parse(parsed);
}

/**
 * 学ぶ言語・訳文の言語のペアから、翻訳専用の `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `window.LanguageModel` は診断済み(availability.ts)である前提で呼び出す。
 */
export function createTranslateBaseSessionFactory(
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return async () =>
    LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildTranslateSystemPrompt(targetLang, explainLang) }],
      expectedInputs: [{ type: "text", languages: [targetLang, explainLang] }],
      expectedOutputs: [{ type: "text", languages: [explainLang] }],
    });
}
