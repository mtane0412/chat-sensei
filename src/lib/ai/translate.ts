/**
 * チャット発言1件をGemini Nano(Prompt API)に翻訳させるオーケストレーション層。
 *
 * `explain.ts` と同じ構造で、翻訳専用のプロンプト・スキーマを使う。
 *
 * - `translateChatMessage`: `SessionPool` にジョブを積み、返ってきたJSON文字列を
 *   `translationSchema` で検証してから返す。自由文をパースする脆い処理は行わない。
 *   Gemini Nano は `responseConstraint` 指定時でも応答 JSON を途中で打ち切ることがある
 *   (issue #19)ため、JSON として解釈できなかった場合に限り、新しいジョブとして
 *   `TRANSLATE_MAX_ATTEMPTS` 回まで明示的に試行し直す。スキーマ不一致は再試行しない。
 * - `createTranslateBaseSessionFactory`: 翻訳専用のシステムプロンプトを持つ
 *   ベースセッションの生成関数を組み立てる。`session-pool.ts` はベースセッションを
 *   1つしか持たないため、翻訳用と解説用でプールを分ける前提(issue #15 の方針 (a))。
 */
import { buildTranslateSystemPrompt, buildTranslateUserPrompt, type SupportedLanguage } from "./prompts";
import { buildTranslationResponseConstraint, translationSchema, type TranslationResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";

/**
 * 翻訳1件あたりの最大試行回数(初回 + 再試行1回)。
 * 応答 JSON の打ち切り(issue #19)への対処として、JSON 解釈失敗時に限り1回だけやり直す。
 */
export const TRANSLATE_MAX_ATTEMPTS = 2;

export interface TranslateOptions {
  /** 翻訳は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
}

/**
 * チャット本文の翻訳を生成する。
 * Prompt API の応答は必ず JSON 文字列として返るため、`JSON.parse` → `translationSchema.parse`
 * の順で検証する。`JSON.parse` に失敗した場合は、直前の応答がコンテキストに残らないよう
 * 別ジョブ(新しいクローンセッション)として `TRANSLATE_MAX_ATTEMPTS` 回まで試行し直し、
 * それでも解釈できなければエラーを投げる。スキーマ不一致は再試行せず即座にエラーを投げる。
 */
export async function translateChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: TranslateOptions = {},
): Promise<TranslationResult> {
  const priority = options.priority ?? "low";

  for (let attempt = 1; ; attempt++) {
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
      if (attempt < TRANSLATE_MAX_ATTEMPTS) continue;
      throw new Error(`Prompt APIの応答をJSONとして解釈できませんでした(${attempt}回試行): ${raw}`, { cause: error });
    }

    return translationSchema.parse(parsed);
  }
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
