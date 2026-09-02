/**
 * 発言者のプロフィール画像(アバター)URL の取得(issue #60)。
 *
 * Helix の Get Users API(`GET /users?id=`)を Next.js プロキシ(`/api/twitch/`)経由で呼び、
 * 発言者の Twitch ユーザー ID(PRIVMSG の `user-id` タグ)からプロフィール画像 URL を取得する。
 * 生IRC列(`src/app/page.tsx`)の発言行にアバターとして表示する。
 * 読み込みのバッチ化と保持は `src/store/avatars.ts` が担う。
 *
 * - `GET /users?id=` は 1 リクエストで最大 100 件まとめて引けるため、
 *   ID を 100 件ずつに分割してバッチで取得する
 * - すべてのリクエスト(チャンク)が失敗した場合のみ null を返す(Helix 未設定の 503・
 *   レート制限・障害・ネットワークエラー)。呼び出し側はこれを「Helix 利用不可」として扱い、
 *   アバターなしの現行表示のまま動作する(意図した仕様)
 * - 一部のチャンクだけが失敗した場合は、成功したチャンクぶんの対応表を返す
 *   (取得できたアバターを捨てない)
 */

import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** Helix の Get Users API の 1 リクエストで指定できる ID の上限 */
const MAX_IDS_PER_REQUEST = 100;

/**
 * Helix の Get Users API レスポンス(`{data: [{id, profile_image_url, ...}]}`)を解析して
 * 「ユーザー ID → プロフィール画像 URL」の対応表を作る。
 * API 側の仕様変更などで形式が想定と異なる項目・URL が空の項目は読み飛ばす。
 */
export function parseUserAvatars(json: unknown): Map<string, string> {
  const avatars = new Map<string, string>();
  const data = extractDataArray(json);
  if (data === null) return avatars;

  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || record.id === "") continue;
    if (typeof record.profile_image_url !== "string" || record.profile_image_url === "") continue;
    avatars.set(record.id, record.profile_image_url);
  }
  return avatars;
}

/**
 * Helix プロキシ(`/api/twitch/users`)から、指定した発言者 ID のプロフィール画像 URL を
 * まとめて取得する。重複 ID は 1 件にまとめ、100 件を超える場合はリクエストを分割する。
 *
 * すべてのチャンクが失敗した場合(Helix 未設定の 503・レート制限・障害などの HTTP エラー・
 * ネットワークエラー)は null を返す(呼び出し側の `src/store/avatars.ts` が
 * 「Helix 利用不可」として扱う。意図した仕様)。
 * 一部のチャンクだけが失敗した場合は、成功したチャンクぶんの対応表を返す。
 *
 * レスポンスに含まれない ID(退会済みユーザーなど)は対応表に載らないだけで、エラーではない。
 */
export async function fetchUserAvatars(
  userIds: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, string> | null> {
  const uniqueIds = [...new Set(userIds)];
  const avatars = new Map<string, string>();
  let anyChunkSucceeded = false;

  for (let start = 0; start < uniqueIds.length; start += MAX_IDS_PER_REQUEST) {
    const chunk = uniqueIds.slice(start, start + MAX_IDS_PER_REQUEST);
    const params = new URLSearchParams();
    for (const id of chunk) params.append("id", id);

    const json = await fetchHelixJson("users", {
      params,
      fetchFn,
      failureLog: { subject: "発言者アバター", fallback: "アバターなしで表示します" },
    });
    if (json === null) {
      // 取得済みのチャンクぶんは捨てない。1 件も取得できていなければ Helix 利用不可(null)
      return anyChunkSucceeded ? avatars : null;
    }
    for (const [id, url] of parseUserAvatars(json)) {
      avatars.set(id, url);
    }
    anyChunkSucceeded = true;
  }
  return avatars;
}
