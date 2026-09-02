/**
 * サードパーティ emote(BTTV / FFZ / 7TV)の対応表を保持するモジュールスコープのストア。
 *
 * `chat-connection.ts` が ROOMSTATE の `room-id`(配信者の Twitch ユーザー ID)を受け取った時点で
 * `loadThirdPartyEmotes` を呼び、以降の発言受信時に `getThirdPartyEmoteMap` で同期的に参照する。
 * 発言の受信は高頻度なため、対応表は React の state ではなくモジュールスコープに置き、
 * 受信ハンドラから直接読めるようにする(`chat-connection.ts` のクライアント保持と同じ方針)。
 *
 * - 同じ Twitch ID への読み込みは 1 回だけ行う(ROOMSTATE は再接続などで複数回届く)
 * - チャンネル切り替え(`connect()`)時は `clearThirdPartyEmotes` で対応表を破棄し、
 *   読み込み途中だった前チャンネルの結果は世代番号の比較で捨てる
 */
import { fetchThirdPartyEmoteMap } from "@/lib/twitch/third-party-emotes";

/** emote 名 → プレフィックス付き ID(`bttv:xxx` など)の対応表 */
let emoteMap: ReadonlyMap<string, string> = new Map();
/** 読み込み済み(または読み込み中)の Twitch ユーザー ID。未読み込みなら null */
let loadedRoomId: string | null = null;
/** クリア・読み込み開始のたびに進める世代番号。読み込み完了時に世代が変わっていたら結果を破棄する */
let generation = 0;

/** 現在の対応表を返す。未読み込み・クリア直後は空の Map */
export function getThirdPartyEmoteMap(): ReadonlyMap<string, string> {
  return emoteMap;
}

/**
 * 指定した配信者の Twitch ユーザー ID でサードパーティ emote を読み込む。
 * 同じ ID で読み込み済み(読み込み中を含む)の場合は何もしない。
 */
export async function loadThirdPartyEmotes(
  roomId: string,
  fetchEmoteMap: (twitchUserId: string) => Promise<Map<string, string>> = fetchThirdPartyEmoteMap,
): Promise<void> {
  if (loadedRoomId === roomId) return;
  loadedRoomId = roomId;
  // 世代番号を進めてから控える。別チャンネルの読み込みを新しく開始した時点で
  // 進行中の古い読み込みを無効化し、遅れて届いた結果による上書きを防ぐ
  const requestGeneration = ++generation;

  const map = await fetchEmoteMap(roomId);

  // 読み込み中にチャンネルが切り替わっていたら(クリア済みなら)、前チャンネルの結果は捨てる
  if (generation !== requestGeneration) return;
  emoteMap = map;
}

/** 対応表を破棄して未読み込み状態に戻す。チャンネル切り替え時に呼ぶ */
export function clearThirdPartyEmotes(): void {
  generation += 1;
  emoteMap = new Map();
  loadedRoomId = null;
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetThirdPartyEmotesForTests(): void {
  clearThirdPartyEmotes();
}
