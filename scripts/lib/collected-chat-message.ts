/**
 * 実チャット評価(issue #117)用に収集したチャットログの1行分のスキーマ。
 *
 * 収集スクリプト(`scripts/collect-chat-log.ts`)が書き出し、評価スクリプト
 * (`scripts/evaluate-pickup-candidates.ts`)が読み込む。プライバシー保護のため、
 * 発言者のユーザー名・表示名・ユーザーIDは項目として持たず、本文も @メンションを除去済みのものだけを持つ。
 */
import { z } from "zod";

export const collectedChatMessageSchema = z.object({
  /** 発言の時刻(ミリ秒のUNIXタイムスタンプ) */
  timestampMs: z.number(),
  /** `preparePickupInput` 適用後の本文(emote・@メンション・URL を除去済み。Pick up が LLM に渡す本文と同じ) */
  text: z.string(),
});

export type CollectedChatMessage = z.infer<typeof collectedChatMessageSchema>;
