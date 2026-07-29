/**
 * 自動抽出パイプラインの2段階目。message-filter.ts を通過した発言に対し、
 * Gemini Nano(Prompt API)へ `responseConstraint: { type: "boolean" }` で
 * 「学習者にとって学ぶ価値があるか」を判定させるオーケストレーション層。
 *
 * explain.ts と同じ `SessionPool`(単一セッションの優先度付き直列キュー)を
 * 呼び出し側から受け取って共有し、Prompt API の呼び出しは常に低優先度("low")で
 * enqueueする(手動ピックによる解説生成が常に優先される設計のため)。
 */
import { buildTriageUserPrompt } from "./prompts";
import { buildTriageResponseConstraint, triageResultSchema } from "./schemas";
import type { SessionPool } from "./session-pool";

export interface TriageOptions {
  signal?: AbortSignal;
}

/**
 * チャット本文が学習者にとって学ぶ価値があるかを判定する。
 * Prompt API の応答は必ず JSON 文字列(`"true"` / `"false"`)として返るため、
 * `JSON.parse` → `triageResultSchema.parse` の順で検証し、いずれかに失敗した場合は
 * エラーを投げる(あいまいな自由文解析へのフォールバックはしない)。
 */
export async function triageChatMessage(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: TriageOptions = {},
): Promise<boolean> {
  const raw = await sessionPool.enqueue(
    "low",
    (session) =>
      session.prompt(buildTriageUserPrompt(chatMessageText), {
        responseConstraint: buildTriageResponseConstraint(),
      }),
    options.signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Prompt APIの応答をJSONとして解釈できませんでした: ${raw}`, { cause: error });
  }

  return triageResultSchema.parse(parsed);
}
