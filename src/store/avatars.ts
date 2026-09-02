/**
 * 発言者アバター(プロフィール画像 URL)のキャッシュを保持する Zustand ストア(issue #60)。
 *
 * `chat-connection.ts` が発言(PRIVMSG)受信時に `requestAvatar` へ発言者の
 * Twitch ユーザー ID(`user-id` タグ)を渡す。ID は短い待ち時間(`AVATAR_BATCH_WINDOW_MS`)で
 * バッチにまとめ、Helix の Get Users API(`src/lib/twitch/user-avatars.ts`。
 * 1 リクエスト最大 100 件)でプロフィール画像 URL を取得する。
 * 生IRC列(`src/app/page.tsx`)は取得結果の反映で行を再描画する必要があるため、
 * cheermotes / third-party-emotes と異なり Zustand ストアで保持する。
 *
 * - アバターはユーザー固有でチャンネル固有ではないため、キャッシュはチャンネル切り替えを
 *   またいで持ち越す。上限(`MAX_AVATAR_CACHE_ENTRIES`)を超えたら参照が最も古い
 *   発言者から捨てる(LRU。取得済み ID への再要求で参照位置を更新する)
 * - レスポンスに含まれない ID(退会済みユーザーなど)は「アバターなし」(null)として
 *   キャッシュに確定し、再取得しない。この負のキャッシュも同じ上限で管理する
 * - 取得の失敗(全チャンクの失敗 = null)は Helix 側の問題(未設定・障害・レート制限)であり
 *   ID 固有の問題ではないため、利用不可フラグを立てて以降の取得を止める(発言のたびに
 *   リクエストを繰り返さない)。チャンネル切り替え(`connect()`)時に
 *   `clearAvatarLoadFailures` でフラグを下ろし、再試行できるようにする
 * - 未取得・取得失敗の発言者はアバターなしの現行表示のまま動作する(意図した仕様)
 */
import { create } from "zustand";
import { fetchUserAvatars } from "@/lib/twitch/user-avatars";

/** 発言者 ID の要求をバッチにまとめる待ち時間(ミリ秒) */
export const AVATAR_BATCH_WINDOW_MS = 250;

/** キャッシュに保持する発言者数の上限。超えたら参照が最も古い発言者から捨てる */
export const MAX_AVATAR_CACHE_ENTRIES = 500;

interface AvatarState {
  /** 発言者の Twitch ユーザー ID → プロフィール画像 URL。未取得・取得失敗・アバターなし確定の ID は含まれない */
  avatars: Record<string, string>;
}

export const useAvatarStore = create<AvatarState>(() => ({ avatars: {} }));

/**
 * 取得結果のキャッシュ(単一の情報源)。値 null は「アバターなし」の確定
 * (レスポンスに含まれなかった退会済みユーザーなど)。
 * 挿入順 = 最終参照順として扱い、上限超過時に先頭(最も古い参照)から捨てる。
 */
const avatarCache = new Map<string, string | null>();
/** 次のバッチで取得する ID */
let pendingIds = new Set<string>();
/** リクエスト送信済み・未応答の ID。応答までの間の二重リクエストを防ぐ */
const inFlightIds = new Set<string>();
/** バッチ取得の待ちタイマー。null なら未スケジュール */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Helix 利用不可(取得の全面失敗)を検出したか。立っている間は新しい取得を止める */
let helixUnavailable = false;
/** clearAvatarLoadFailures のたびに進める世代番号。クリア前に開始したバッチの失敗を利用不可として記録しない */
let generation = 0;

/**
 * 発言者のアバター取得を要求する。発言(PRIVMSG)受信のたびに呼ばれるため、
 * 要求はバッチにまとめ、取得済み(アバターなし確定を含む)・取得中の ID は再取得しない。
 * userId が null(タグ無し)・空文字(値なしタグ)の発言は無視する。
 */
export function requestAvatar(userId: string | null): void {
  if (userId === null || userId === "") return;
  if (helixUnavailable) return;
  if (pendingIds.has(userId) || inFlightIds.has(userId)) return;

  const cached = avatarCache.get(userId);
  if (cached !== undefined) {
    // 取得済み: 参照位置を最新に更新し(LRU)、上限超過時に捨てられにくくする
    avatarCache.delete(userId);
    avatarCache.set(userId, cached);
    return;
  }

  pendingIds.add(userId);
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      void flushPendingRequests();
    }, AVATAR_BATCH_WINDOW_MS);
  }
}

/** 溜まった ID をまとめて取得し、結果をキャッシュとストアへ反映する */
async function flushPendingRequests(): Promise<void> {
  flushTimer = null;
  const ids = [...pendingIds];
  pendingIds = new Set();
  for (const id of ids) inFlightIds.add(id);
  const requestGeneration = generation;

  const result = await fetchUserAvatars(ids);

  for (const id of ids) inFlightIds.delete(id);

  if (result === null) {
    // Helix 利用不可(全チャンクの失敗): 発言のたびに繰り返さないようフラグを立てる。
    // ID はキャッシュに入れないため、clearAvatarLoadFailures 後の発言で再試行できる。
    // クリア(チャンネル切り替え)後に完了した古いバッチの失敗は、新チャンネルの取得を止めない
    if (generation === requestGeneration) helixUnavailable = true;
    return;
  }

  // レスポンスに含まれない ID(退会済みなど)は「アバターなし」(null)として確定する
  for (const id of ids) {
    avatarCache.set(id, result.get(id) ?? null);
  }
  // 上限を超えたぶんは参照が最も古い発言者(挿入順の先頭)から捨てる
  while (avatarCache.size > MAX_AVATAR_CACHE_ENTRIES) {
    const oldestId = avatarCache.keys().next().value;
    if (oldestId === undefined) break;
    avatarCache.delete(oldestId);
  }
  publishAvatars();
}

/** キャッシュのうちアバターありの ID だけをストアへ反映し、生IRC列の行を再描画させる */
function publishAvatars(): void {
  const avatars: Record<string, string> = {};
  for (const [id, url] of avatarCache) {
    if (url !== null) avatars[id] = url;
  }
  useAvatarStore.setState({ avatars });
}

/**
 * Helix 利用不可フラグを下ろし、取得に失敗していた発言者を再取得できるようにする。
 * チャンネル切り替え(`connect()`)時に呼ぶ(取得済みのキャッシュは持ち越す)。
 */
export function clearAvatarLoadFailures(): void {
  generation += 1;
  helixUnavailable = false;
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetAvatarsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  avatarCache.clear();
  pendingIds = new Set();
  inFlightIds.clear();
  helixUnavailable = false;
  generation += 1;
  useAvatarStore.setState({ avatars: {} });
}
