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
 *   またいで持ち越す。ただし上限(`MAX_AVATAR_CACHE_ENTRIES`)を超えたら古い発言者から捨てる
 * - 取得失敗(Helix 利用不可 = null)の ID は失敗として記録し、発言のたびに
 *   リクエストを繰り返さない。チャンネル切り替え(`connect()`)時に
 *   `clearAvatarLoadFailures` で記録をクリアし、再試行できるようにする
 * - レスポンスに含まれない ID(退会済みユーザーなど)はアバターなしとして確定し、再取得しない
 * - 未取得・取得失敗の発言者はアバターなしの現行表示のまま動作する(意図した仕様)
 */
import { create } from "zustand";
import { fetchUserAvatars } from "@/lib/twitch/user-avatars";

/** 発言者 ID の要求をバッチにまとめる待ち時間(ミリ秒) */
export const AVATAR_BATCH_WINDOW_MS = 250;

/** キャッシュに保持するアバター URL の上限件数。超えたら古い発言者から捨てる */
export const MAX_AVATAR_CACHE_ENTRIES = 500;

interface AvatarState {
  /** 発言者の Twitch ユーザー ID → プロフィール画像 URL。未取得・取得失敗の ID は含まれない */
  avatars: Record<string, string>;
}

export const useAvatarStore = create<AvatarState>(() => ({ avatars: {} }));

/** 取得済みアバター URL のキャッシュ(挿入順 = 取得順。上限超過時に先頭から捨てる) */
const avatarCache = new Map<string, string>();
/** 要求済み(取得中・取得済み・アバターなし確定)の ID。二重リクエストを防ぐ */
const requestedIds = new Set<string>();
/** 取得失敗(Helix 利用不可)だった ID。クリアされるまで再取得しない */
const failedIds = new Set<string>();
/** 次のバッチで取得する ID */
let pendingIds = new Set<string>();
/** バッチ取得の待ちタイマー。null なら未スケジュール */
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** 次のバッチ取得に使う取得関数(テストではフェイクを注入する) */
let pendingFetchAvatars: typeof fetchUserAvatars = fetchUserAvatars;

/**
 * 発言者のアバター取得を要求する。発言(PRIVMSG)受信のたびに呼ばれるため、
 * 要求はバッチにまとめ、要求済みの ID は何もしない。
 * userId が null(タグ無し)の発言は無視する。
 */
export function requestAvatar(
  userId: string | null,
  fetchAvatars: typeof fetchUserAvatars = fetchUserAvatars,
): void {
  if (userId === null) return;
  if (requestedIds.has(userId) || failedIds.has(userId)) return;

  requestedIds.add(userId);
  pendingIds.add(userId);
  pendingFetchAvatars = fetchAvatars;
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
  const fetchAvatars = pendingFetchAvatars;

  const result = await fetchAvatars(ids);

  if (result === null) {
    // Helix 利用不可・一時的な失敗: 発言のたびに繰り返さないよう失敗として記録する。
    // チャンネル切り替え時の clearAvatarLoadFailures で再試行できるようになる
    for (const id of ids) {
      requestedIds.delete(id);
      failedIds.add(id);
    }
    return;
  }

  // レスポンスに含まれない ID(退会済みなど)は requestedIds に残り、アバターなしとして確定する
  for (const [id, url] of result) {
    avatarCache.set(id, url);
  }
  // 上限を超えたぶんは古い発言者(挿入順の先頭)から捨て、再要求できるようにする
  while (avatarCache.size > MAX_AVATAR_CACHE_ENTRIES) {
    const oldestId = avatarCache.keys().next().value as string;
    avatarCache.delete(oldestId);
    requestedIds.delete(oldestId);
  }
  useAvatarStore.setState({ avatars: Object.fromEntries(avatarCache) });
}

/**
 * 取得失敗の記録をクリアし、失敗した ID を再取得できるようにする。
 * チャンネル切り替え(`connect()`)時に呼ぶ(取得済みのキャッシュは持ち越す)。
 */
export function clearAvatarLoadFailures(): void {
  failedIds.clear();
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetAvatarsForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  avatarCache.clear();
  requestedIds.clear();
  failedIds.clear();
  pendingIds = new Set();
  pendingFetchAvatars = fetchUserAvatars;
  useAvatarStore.setState({ avatars: {} });
}
