/**
 * LLM プロバイダ切替層。設定(`lib/settings.ts` の `llmProvider`)に応じて、
 * 翻訳・Pick up のセッションプールに渡すベースセッション生成関数を組み立てる。
 *
 * - "gemini-nano": Chrome 内蔵の Prompt API(`structured-prompt.ts` の `createBaseSessionFactory`)
 * - "openrouter": 利用者の API キーで OpenRouter を呼ぶ互換セッション(`openrouter.ts`)
 *
 * どちらも `PromptSessionLike` を返すため、セッションプール・構造化プロンプト・パイプラインは
 * プロバイダを意識せずそのまま動く。発言ごとの言語判定(Language Detector)は
 * プロバイダに関わらずブラウザ内蔵 API を使い続ける。
 */
import type { Settings } from "@/lib/settings";
import { createOpenRouterSessionFactory } from "./openrouter";
import type { SupportedLanguage } from "./prompts";
import type { PromptSessionLike } from "./session-pool";
import { createBaseSessionFactory } from "./structured-prompt";

/**
 * 設定・用途ごとのシステムプロンプト組み立て関数・言語ペアから、
 * 現在のプロバイダに対応するベースセッション生成関数を組み立てる。
 * `expectedOutputLanguages` は Gemini Nano の `expectedOutputs` に渡す出力言語の宣言
 * (省略時は解説言語のみ)。OpenRouter には対応する概念が無いため無視される。
 */
export function createLlmBaseSessionFactory(
  settings: Settings,
  buildSystemPrompt: (targetLang: SupportedLanguage, explainLang: SupportedLanguage) => string,
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  expectedOutputLanguages?: readonly SupportedLanguage[],
): () => Promise<PromptSessionLike> {
  switch (settings.llmProvider) {
    case "gemini-nano":
      return createBaseSessionFactory(buildSystemPrompt, targetLang, explainLang, expectedOutputLanguages ?? [explainLang]);
    case "openrouter":
      return createOpenRouterSessionFactory({
        apiKey: settings.openRouterApiKey,
        model: settings.openRouterModel,
        systemPrompt: buildSystemPrompt(targetLang, explainLang),
      });
  }
}
