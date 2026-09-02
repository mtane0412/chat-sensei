/**
 * Cheermote 一覧(グローバル + チャンネル独自)を保持するモジュールスコープのストア。
 *
 * `chat-connection.ts` が ROOMSTATE の `room-id`(配信者の Twitch ユーザー ID)を受け取った時点で
 * `loadCheermotes` を呼び、以降の発言受信時に `getCheermoteSet` で同期的に参照する。
 * 発言の受信は高頻度なため、一覧は React の state ではなくモジュールスコープに置き、
 * 受信ハンドラから直接読めるようにする(`third-party-emotes.ts` と同じ方針)。
 *
 * - 読み込み成功時は `emotes.ts` の `registerCheermoteImageUrls` にも画像 URL を登録し、
 *   `buildEmoteImageUrl` が Helix API 由来の画像 URL を返せるようにする
 * - Helix が利用できない場合(`fetchCheermoteSet` が null)は静的一覧
 *   `STATIC_CHEERMOTE_SET` のまま動作する(意図したフォールバック。issue #53)。
 *   一時的な失敗の可能性があるため、次の ROOMSTATE で再試行できるように未読み込み状態へ戻す
 * - 同じ Twitch ID への読み込みは 1 回だけ行う(ROOMSTATE は再接続などで複数回届く)
 * - チャンネル切り替え(`connect()`)時は `clearCheermotes` で一覧を破棄し、
 *   読み込み途中だった前チャンネルの結果は世代番号の比較で捨てる
 */
import {
  STATIC_CHEERMOTE_SET,
  buildCheermoteImageUrlMap,
  fetchCheermoteSet,
  type CheermoteSet,
} from "@/lib/twitch/cheermotes";
import { registerCheermoteImageUrls } from "@/lib/twitch/emotes";

/** 現在の Cheermote 一覧。未読み込み・クリア直後・読み込み失敗時は静的一覧 */
let cheermoteSet: CheermoteSet = STATIC_CHEERMOTE_SET;
/** 読み込み済み(または読み込み中)の Twitch ユーザー ID。未読み込みなら null */
let loadedRoomId: string | null = null;
/** クリア・読み込み開始のたびに進める世代番号。読み込み完了時に世代が変わっていたら結果を破棄する */
let generation = 0;

/** 現在の Cheermote 一覧を返す。未読み込み・クリア直後は静的一覧(STATIC_CHEERMOTE_SET) */
export function getCheermoteSet(): CheermoteSet {
  return cheermoteSet;
}

/**
 * 指定した配信者の Twitch ユーザー ID で Cheermote 一覧を読み込む。
 * 同じ ID で読み込み済み(読み込み中を含む)の場合は何もしない。
 * 読み込みに失敗した場合は静的一覧のまま、次の ROOMSTATE で再試行できる状態に戻す。
 */
export async function loadCheermotes(
  roomId: string,
  fetchSet: (broadcasterId: string) => Promise<CheermoteSet | null> = fetchCheermoteSet,
): Promise<void> {
  if (loadedRoomId === roomId) return;
  loadedRoomId = roomId;
  // 世代番号を進めてから控える。別チャンネルの読み込みを新しく開始した時点で
  // 進行中の古い読み込みを無効化し、遅れて届いた結果による上書きを防ぐ
  const requestGeneration = ++generation;

  const set = await fetchSet(roomId);

  // 読み込み中にチャンネルが切り替わっていたら(クリア済みなら)、前チャンネルの結果は捨てる
  if (generation !== requestGeneration) return;

  if (set === null) {
    // Helix 利用不可・一時的な失敗: 静的一覧のまま、次の ROOMSTATE で再試行できるようにする
    loadedRoomId = null;
    return;
  }

  cheermoteSet = set;
  registerCheermoteImageUrls(buildCheermoteImageUrlMap(set));
}

/** 一覧を静的一覧・静的 CDN URL に戻して未読み込み状態にする。チャンネル切り替え時に呼ぶ */
export function clearCheermotes(): void {
  generation += 1;
  cheermoteSet = STATIC_CHEERMOTE_SET;
  loadedRoomId = null;
  registerCheermoteImageUrls(new Map());
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetCheermotesForTests(): void {
  clearCheermotes();
}
