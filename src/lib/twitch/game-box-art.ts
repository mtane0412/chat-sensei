/**
 * 配信カテゴリ(ゲーム)のボックスアート URL の取得。
 *
 * Helix の Get Games API(`GET /games?id=`)を Next.js プロキシ(`/api/twitch/`)経由で呼び、
 * 配信情報(`stream-info.ts`)の `gameId` からボックスアート画像の URL を取得する。
 * 接続中の配信者情報パネル(`src/components/stream-info-panel.tsx`)でカテゴリ画像として表示する。
 *
 * Helix が返す `box_art_url` は `{width}x{height}` プレースホルダ付きのテンプレートのため、
 * Twitch 標準のボックスアートサイズ(285x380)に解決してから返す。
 *
 * 取得できない場合は null を返し、ボックスアートなし(カテゴリ名のテキストのみ)で動作を続ける:
 * - ゲームID が空文字(カテゴリ未設定の配信)
 * - 未知のゲームID(`data` が空)・レスポンス形式が想定と異なる
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害・ネットワークエラー
 */

import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** ボックスアートの取得サイズ。Twitch が標準的に使う 3:4 のサイズ */
const BOX_ART_WIDTH = 285;
const BOX_ART_HEIGHT = 380;

/**
 * Helix の Get Games API レスポンス(`{data: [{box_art_url, ...}]}`)を解析し、
 * `{width}x{height}` プレースホルダを実サイズに解決したボックスアート URL を返す。
 * `data` が空(未知のゲームID)・`box_art_url` が無い・型が違う・空文字の場合は null を返す。
 */
export function parseGameBoxArtUrl(json: unknown): string | null {
  const data = extractDataArray(json);
  if (data === null || data.length === 0) return null;

  const first = data[0];
  if (typeof first !== "object" || first === null) return null;
  const boxArtUrl = (first as Record<string, unknown>).box_art_url;
  if (typeof boxArtUrl !== "string" || boxArtUrl === "") return null;

  return boxArtUrl.replace("{width}", String(BOX_ART_WIDTH)).replace("{height}", String(BOX_ART_HEIGHT));
}

/**
 * Helix プロキシ(`/api/twitch/games`)から、指定したゲームID のボックスアート URL を取得する。
 * 取得できない場合は null を返す(呼び出し側はボックスアートなしで動作を続ける。意図した仕様)。
 */
export async function fetchGameBoxArtUrl(
  gameId: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  if (gameId === "") return null;

  const json = await fetchHelixJson("games", {
    params: new URLSearchParams({ id: gameId }),
    fetchFn,
    failureLog: { subject: "カテゴリのボックスアート", fallback: "カテゴリ名のみで表示します" },
  });
  if (json === null) return null;
  return parseGameBoxArtUrl(json);
}
