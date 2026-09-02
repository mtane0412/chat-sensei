/**
 * チャットバッジ画像対応表(「set_id/version → 画像 URL」)を保持する Zustand ストア(issue #61)。
 *
 * `chat-connection.ts` が ROOMSTATE の `room-id`(配信者の Twitch ユーザー ID)を受け取った時点で
 * `loadBadges` を呼び、Helix の Chat Badges API(`src/lib/twitch/badges.ts`)から
 * グローバル + チャンネル固有の対応表を読み込む(`src/store/cheermotes.ts` と同じ方針)。
 * 生IRC列(`src/app/page.tsx`)は発言行の `badges` タグを描画時に画像へ解決するため、
 * 読み込み完了で行が再描画されるよう Zustand ストアで保持する。
 *
 * - Helix が利用できない場合(`fetchBadgeImageMap` が null)は空の対応表のまま
 *   バッジ非表示で動作する(意図したフォールバック)。一時的な失敗の可能性があるため、
 *   次の ROOMSTATE で再試行できるように未読み込み状態へ戻す
 * - 同じ Twitch ID への読み込みは 1 回だけ行う(ROOMSTATE は再接続などで複数回届く)
 * - チャンネル切り替え(`connect()`)時は `clearBadges` で対応表を破棄し、
 *   読み込み途中だった前チャンネルの結果は世代番号の比較で捨てる
 */
import { create } from "zustand";
import { fetchBadgeImageMap, type BadgeImageMap } from "@/lib/twitch/badges";

interface BadgeState {
  /** 「set_id/version → 画像 URL」の対応表。未読み込み・クリア直後・読み込み失敗時は空 */
  badgeImages: Record<string, string>;
}

export const useBadgeStore = create<BadgeState>(() => ({ badgeImages: {} }));

/** 読み込み済み(または読み込み中)の Twitch ユーザー ID。未読み込みなら null */
let loadedRoomId: string | null = null;
/** クリア・読み込み開始のたびに進める世代番号。読み込み完了時に世代が変わっていたら結果を破棄する */
let generation = 0;

/**
 * 指定した配信者の Twitch ユーザー ID でバッジ対応表を読み込む。
 * 同じ ID で読み込み済み(読み込み中を含む)の場合は何もしない。
 * 読み込みに失敗した場合は空の対応表のまま、次の ROOMSTATE で再試行できる状態に戻す。
 */
export async function loadBadges(
  roomId: string,
  fetchMap: (broadcasterId: string) => Promise<BadgeImageMap | null> = fetchBadgeImageMap,
): Promise<void> {
  if (loadedRoomId === roomId) return;
  loadedRoomId = roomId;
  // 世代番号を進めてから控える。別チャンネルの読み込みを新しく開始した時点で
  // 進行中の古い読み込みを無効化し、遅れて届いた結果による上書きを防ぐ
  const requestGeneration = ++generation;

  const map = await fetchMap(roomId);

  // 読み込み中にチャンネルが切り替わっていたら(クリア済みなら)、前チャンネルの結果は捨てる
  if (generation !== requestGeneration) return;

  if (map === null) {
    // Helix 利用不可・一時的な失敗: バッジ非表示のまま、次の ROOMSTATE で再試行できるようにする
    loadedRoomId = null;
    return;
  }

  useBadgeStore.setState({ badgeImages: Object.fromEntries(map) });
}

/** 対応表を破棄して未読み込み状態にする。チャンネル切り替え時に呼ぶ */
export function clearBadges(): void {
  generation += 1;
  loadedRoomId = null;
  useBadgeStore.setState({ badgeImages: {} });
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetBadgesForTests(): void {
  clearBadges();
}
