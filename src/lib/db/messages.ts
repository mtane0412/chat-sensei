/**
 * Twitchチャットメッセージ(`StoredMessage`)の保存・pruneを行うモジュール。
 *
 * ライブ接続中は大量のメッセージが流れ続けるため、チャンネルごとに
 * 直近N件だけをリングバッファ的に保持し、古いメッセージから削除する。
 */
import type { StoredMessage } from "./schema";
import { db } from "./schema";

/** チャンネルごとに保持するメッセージの既定上限件数 */
export const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 2000;

export interface SaveMessageOptions {
  /** チャンネルごとの保持上限件数(テストでは小さい値を指定する) */
  maxMessagesPerChannel?: number;
}

/**
 * メッセージを保存し、同一チャンネルの保存件数が上限を超えていれば
 * `timestampMs` が古い順に削除して上限件数まで間引く。
 */
export async function saveMessage(
  message: Omit<StoredMessage, "id">,
  options: SaveMessageOptions = {},
): Promise<void> {
  const maxMessagesPerChannel = options.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;

  await db.messages.add(message);

  const channelMessages = await db.messages.where("channel").equals(message.channel).sortBy("timestampMs");
  const overflowCount = channelMessages.length - maxMessagesPerChannel;
  if (overflowCount <= 0) {
    return;
  }

  const idsToDelete = channelMessages.slice(0, overflowCount).map((m) => m.id!);
  await db.messages.bulkDelete(idsToDelete);
}
