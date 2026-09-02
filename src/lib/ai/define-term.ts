/**
 * ユーザーが範囲選択した語句1件の意味を LLM(Prompt API / OpenRouter)に生成させる
 * オーケストレーション層(手動Pick up。issue #72)。
 *
 * 自動Pick up(`pickup.ts`)と異なり語句はユーザーが選択済みのため、抽出(`pickupSchema`)ではなく
 * 「この語句の意味を解説言語で返す」専用プロンプト + スキーマ(`termMeaningSchema`)を使う。
 * 実際の「ジョブ投入 → JSON 解釈 → スキーマ検証(→ 再試行)」は `structured-prompt.ts` に
 * 共通化しており、ここでは手動Pick up専用のプロンプト・スキーマを渡すだけにする。
 *
 * - `defineTerm`: ユーザーの明示的な操作が起点のため priority は high 固定で
 *   `runStructuredPrompt` を呼ぶ(`explain.ts` と同じ方針)
 * - `createDefineTermBaseSessionFactory`: 手動Pick up専用のシステムプロンプトを持つ
 *   ベースセッションの生成関数を、設定(LLM プロバイダ)・言語ペア・配信の文脈から組み立てる
 */
import type { Settings } from "@/lib/settings";
import { createLlmBaseSessionFactory } from "./llm-provider";
import {
  buildDefineTermSystemPrompt,
  buildDefineTermUserPrompt,
  type StreamContext,
  type SupportedLanguage,
} from "./prompts";
import { termMeaningSchema, type TermMeaningResult } from "./schemas";
import type { PromptSessionLike, SessionPool } from "./session-pool";
import { runStructuredPrompt } from "./structured-prompt";

export interface DefineTermOptions {
  signal?: AbortSignal;
}

/**
 * 選択した語句の意味を生成する。応答の解釈・検証・再試行の方針は `runStructuredPrompt` に従う。
 * `chatMessageText` は語句が登場した発言の本文で、意味を判断する文脈としてプロンプトに含める。
 */
export async function defineTerm(
  sessionPool: SessionPool,
  term: string,
  chatMessageText: string,
  options: DefineTermOptions = {},
): Promise<TermMeaningResult> {
  return runStructuredPrompt(sessionPool, {
    userPrompt: buildDefineTermUserPrompt(term, chatMessageText),
    schema: termMeaningSchema,
    priority: "high",
    signal: options.signal,
  });
}

/**
 * 設定(LLM プロバイダ)と学ぶ言語・意味を書く言語のペアから、
 * 手動Pick up専用の `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `streamContext`(配信タイトル・カテゴリ)を渡すとシステムプロンプトの末尾に
 * 配信の文脈として追記される(issue #54)。null / 省略時は文脈なしのプロンプトになる。
 */
export function createDefineTermBaseSessionFactory(
  settings: Settings,
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  streamContext?: StreamContext | null,
): () => Promise<PromptSessionLike> {
  return createLlmBaseSessionFactory(
    settings,
    (target, explain) => buildDefineTermSystemPrompt(target, explain, streamContext),
    targetLang,
    explainLang,
  );
}
