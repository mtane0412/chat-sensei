/**
 * Gemini Nano(Prompt API)に構造化 JSON を生成させる処理の共通層。
 * 翻訳(`translate.ts`)・Pick up(`pickup.ts`)・解説(`explain.ts`)はいずれも
 * 「`SessionPool` にジョブを積む → 応答を `JSON.parse` → zod スキーマで検証」という同じ流れのため、
 * ここに 1 つだけ実装し、各用途はユーザープロンプトとスキーマを渡すだけの薄いラッパーにする。
 *
 * - `runStructuredPrompt`: 応答は必ず JSON 文字列として返るため `JSON.parse` → `schema.parse` の順で検証する。
 *   Gemini Nano は `responseConstraint` 指定時でも応答 JSON を途中で打ち切ることがある(issue #19)ため、
 *   JSON として解釈できなかった場合に限り、直前の応答がコンテキストに残らないよう別ジョブ
 *   (新しいクローンセッション)として `STRUCTURED_PROMPT_MAX_ATTEMPTS` 回まで試行し直す。
 *   スキーマ不一致は再試行せず即座にエラーを投げる(自由文をパースする脆いフォールバックはしない)。
 * - `createBaseSessionFactory`: 用途ごとのシステムプロンプトを持つベースセッションの生成関数を組み立てる。
 *   `window.LanguageModel` を実際に呼び出す唯一の場所。`SessionPool` はベースセッションを
 *   1 つしか持たないため、用途ごとにプールを分ける前提(issue #15 の方針 (a))。
 *   ただし直列キュー(`PromptJobQueue`)は用途をまたいで 1 つを共有し、並走させない(issue #23)。
 */
import type { z } from "zod";
import type { SupportedLanguage } from "./prompts";
import { toResponseConstraint } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";

/**
 * 1 件あたりの最大試行回数(初回 + 再試行 1 回)。
 * 応答 JSON の打ち切り(issue #19)への対処として、JSON 解釈失敗時に限り 1 回だけやり直す。
 */
export const STRUCTURED_PROMPT_MAX_ATTEMPTS = 2;

export interface StructuredPromptRequest<TSchema extends z.ZodType> {
  /** モデルに渡すユーザープロンプト(組み立て済みの文字列) */
  userPrompt: string;
  /** 応答の検証に使う zod スキーマ。`responseConstraint` もここから導出する */
  schema: TSchema;
  priority: JobPriority;
  signal?: AbortSignal;
}

/**
 * ユーザープロンプトを `SessionPool` のジョブとして投げ、応答をスキーマで検証した値を返す。
 * JSON として解釈できなければ `STRUCTURED_PROMPT_MAX_ATTEMPTS` 回まで別ジョブとして試行し直し、
 * それでも解釈できなければ試行回数を含めたエラーを投げる。
 */
export async function runStructuredPrompt<TSchema extends z.ZodType>(
  sessionPool: SessionPool,
  request: StructuredPromptRequest<TSchema>,
): Promise<z.infer<TSchema>> {
  const responseConstraint = toResponseConstraint(request.schema);

  for (let attempt = 1; ; attempt++) {
    const raw = await sessionPool.enqueue(
      request.priority,
      (session) => session.prompt(request.userPrompt, { responseConstraint }),
      request.signal,
    );

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      if (attempt < STRUCTURED_PROMPT_MAX_ATTEMPTS) continue;
      throw new Error(`Could not parse the Prompt API response as JSON (${attempt} attempts): ${raw}`, { cause: error });
    }

    return request.schema.parse(parsed);
  }
}

/**
 * システムプロンプトの組み立て関数と、学ぶ言語・解説言語のペアから、
 * `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `window.LanguageModel` は診断済み(availability.ts)である前提で呼び出す。
 */
export function createBaseSessionFactory(
  buildSystemPrompt: (targetLang: SupportedLanguage, explainLang: SupportedLanguage) => string,
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return async () =>
    LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildSystemPrompt(targetLang, explainLang) }],
      expectedInputs: [{ type: "text", languages: [targetLang, explainLang] }],
      expectedOutputs: [{ type: "text", languages: [explainLang] }],
    });
}
