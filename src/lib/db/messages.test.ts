/**
 * src/lib/db/messages.ts のテスト。
 *
 * fake-indexeddb を使い、Twitchチャットメッセージの保存と
 * チャンネルごとのリングバッファ的なprune(直近N件を超えたら古い順に削除)を検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./schema";
import { saveMessage } from "./messages";
import type { StoredMessage } from "./schema";

/** テスト用のTwitchチャットメッセージ入力(意味の分かる日本語・実チャット文を使用) */
function buildMessageInput(overrides: Partial<Omit<StoredMessage, "id">> = {}): Omit<StoredMessage, "id"> {
  return {
    channel: "zackrawrr",
    userId: "12345",
    displayName: "yamada_taro",
    color: "#1E90FF",
    text: "GG everyone, that was such a clutch play!",
    emotes: [],
    timestampMs: 1_000,
    detectedLang: null,
    confidence: null,
    ...overrides,
  };
}

afterEach(async () => {
  await db.messages.clear();
});

describe("saveMessage", () => {
  it("メッセージをそのまま保存し、DBから取得できる", async () => {
    await saveMessage(buildMessageInput());

    const stored = await db.messages.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      channel: "zackrawrr",
      displayName: "yamada_taro",
      text: "GG everyone, that was such a clutch play!",
    });
  });

  it("同一チャンネルのメッセージが上限を超えたら、古い順に削除して直近N件だけ残す", async () => {
    for (let i = 0; i < 5; i++) {
      await saveMessage(buildMessageInput({ text: `message-${i}`, timestampMs: i }), { maxMessagesPerChannel: 3 });
    }

    const remaining = await db.messages.where("channel").equals("zackrawrr").toArray();
    expect(remaining.map((m) => m.text)).toEqual(["message-2", "message-3", "message-4"]);
  });

  it("prune対象は同一チャンネルのみで、他チャンネルのメッセージは削除しない", async () => {
    await saveMessage(buildMessageInput({ channel: "other_channel", text: "other channel message" }), {
      maxMessagesPerChannel: 3,
    });
    for (let i = 0; i < 4; i++) {
      await saveMessage(buildMessageInput({ text: `message-${i}`, timestampMs: i }), { maxMessagesPerChannel: 3 });
    }

    const otherChannelMessages = await db.messages.where("channel").equals("other_channel").toArray();
    expect(otherChannelMessages).toHaveLength(1);
  });
});
