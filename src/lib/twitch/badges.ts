/**
 * チャットバッジ(サブスク・モデレーター・VIP など)の画像 URL 対応表(issue #61)。
 *
 * Helix の Chat Badges API(`GET /chat/badges/global` と `GET /chat/badges?broadcaster_id=`)を
 * Next.js プロキシ(`/api/twitch/`)経由で呼び、IRC の `badges` タグ
 * (`TwitchChatMessage.badges` の `{name, version}`)を画像 URL に解決するための
 * 「set_id/version → 画像 URL」対応表を作る。
 * 特にサブスクバッジはチャンネル固有画像のため、Helix でしか解決できない。
 * 読み込みの流れと保持は `src/store/badges.ts` が担う。
 *
 * - グローバルとチャンネル固有を並行取得してマージし、同じ set_id/version は
 *   チャンネル固有を優先する(Twitch の仕様どおりチャンネル側が上書きする)
 * - 片方だけ取得できない場合は取得できた側だけの対応表を返す。
 *   両方とも取得できない場合(Helix 未設定の 503・障害・ネットワークエラー)は null を返し、
 *   呼び出し側はバッジ非表示のまま現行どおり動作する(意図した仕様)
 * - 画像は 2 倍サイズ(`image_url_2x`)を使う(高解像度ディスプレイでも約 18px 表示が滲まないように)
 */

import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** 「set_id/version → 画像 URL」の対応表 */
export type BadgeImageMap = ReadonlyMap<string, string>;

/**
 * Helix の Chat Badges API レスポンス(`{data: [{set_id, versions: [{id, image_url_2x}]}]}`)を
 * 解析して「set_id/version → 画像 URL」の対応表を作る。
 * API 側の仕様変更などで形式が想定と異なる項目は読み飛ばす。
 */
export function parseBadgeImageMap(json: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const data = extractDataArray(json);
  if (data === null) return map;

  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.set_id !== "string" || record.set_id === "") continue;
    if (!Array.isArray(record.versions)) continue;

    for (const version of record.versions) {
      if (typeof version !== "object" || version === null) continue;
      const versionRecord = version as Record<string, unknown>;
      if (typeof versionRecord.id !== "string" || versionRecord.id === "") continue;
      if (typeof versionRecord.image_url_2x !== "string" || versionRecord.image_url_2x === "") continue;
      map.set(`${record.set_id}/${versionRecord.id}`, versionRecord.image_url_2x);
    }
  }
  return map;
}

/** 1 エンドポイントぶんの対応表を取得する。取得できない場合は null */
async function fetchSingleBadgeMap(
  path: string,
  params: URLSearchParams | undefined,
  fetchFn: typeof fetch,
): Promise<Map<string, string> | null> {
  const json = await fetchHelixJson(path, {
    params,
    fetchFn,
    failureLog: { subject: "チャットバッジ", fallback: "バッジなしで表示します" },
  });
  if (json === null) return null;
  return parseBadgeImageMap(json);
}

/**
 * Helix プロキシから、グローバルバッジと指定した配信者のチャンネル固有バッジを
 * 並行取得してマージした対応表を返す。同じ set_id/version はチャンネル固有を優先する。
 *
 * 片方だけ取得できない場合は取得できた側だけの対応表を返す。
 * 両方とも取得できない場合は null を返す(呼び出し側の `src/store/badges.ts` が
 * 未読み込みのまま次の ROOMSTATE で再試行できるようにする。意図した仕様)。
 */
export async function fetchBadgeImageMap(
  broadcasterId: string,
  fetchFn: typeof fetch = fetch,
): Promise<BadgeImageMap | null> {
  const [globalMap, channelMap] = await Promise.all([
    fetchSingleBadgeMap("chat/badges/global", undefined, fetchFn),
    fetchSingleBadgeMap("chat/badges", new URLSearchParams({ broadcaster_id: broadcasterId }), fetchFn),
  ]);
  if (globalMap === null && channelMap === null) return null;

  // グローバルを先に入れ、チャンネル固有で上書きする(チャンネル固有優先)
  const merged = new Map(globalMap ?? []);
  for (const [key, url] of channelMap ?? []) {
    merged.set(key, url);
  }
  return merged;
}
