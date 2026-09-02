/**
 * 配信タイトル・カテゴリ(ゲーム名)の取得(issue #54)。
 *
 * Helix の Get Streams API(`GET /streams?user_login=`)を Next.js プロキシ
 * (`/api/twitch/`)経由で呼び、接続中チャンネルのライブ配信のタイトルとカテゴリを取得する。
 * 取得した情報は翻訳・Pick up のシステムプロンプト(`src/lib/ai/prompts.ts` の
 * `StreamContext`)に「配信の文脈」として注入し、ゲーム用語やスラングの訳質向上に使う。
 * 読み込みの流れと保持は `src/store/stream-info.ts` が担う。
 *
 * - Get Streams はライブ中の配信だけを返すため、オフラインの場合は `data` が空になる。
 *   このときは null を返し、文脈なしの現行プロンプトのまま動作する(issue #54 で合意した仕様。
 *   オフライン時に Get Channel Information からタイトルを取得することはしない)
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害・ネットワークエラーも null を返し、
 *   文脈なしで動作を続ける(意図したフォールバック)
 */

import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** 接続中チャンネルのライブ配信の情報。カテゴリ未設定の配信では category が空文字になる */
export interface StreamInfo {
  /** 配信タイトル(Helix の `title`) */
  title: string;
  /** 配信カテゴリ = ゲーム名(Helix の `game_name`) */
  category: string;
  /** 配信者の Twitch ユーザー ID(Helix の `user_id`)。アバター取得に使う。取得できない場合は空文字 */
  broadcasterId: string;
  /** 配信者の username(Helix の `user_login`)。取得できない場合は空文字 */
  broadcasterLogin: string;
  /** 配信者の表示名 = DisplayName(Helix の `user_name`。日本語名など)。取得できない場合は空文字 */
  broadcasterName: string;
  /** 配信カテゴリのゲーム ID(Helix の `game_id`)。ボックスアート取得に使う。取得できない場合は空文字 */
  gameId: string;
  /** 同時視聴者数(Helix の `viewer_count`)。取得できない場合は null(表示しないだけ) */
  viewerCount: number | null;
}

/**
 * Helix の Get Streams API レスポンス(`{data: [{title, game_name, user_id, user_login, user_name, game_id, viewer_count, ...}]}`)を
 * 解析して StreamInfo を作る。オフライン(`data` が空)・形式が想定と異なる場合・
 * タイトルとカテゴリの両方が空の場合(文脈として意味が無い)は null を返す。
 * 配信者情報(ID・username・DisplayName)・ゲーム ID は取得できないフィールドだけを空文字として、
 * 視聴者数は null として読み飛ばす(いずれも表示しないだけで、文脈としては成立する)。
 */
export function parseStreamInfo(json: unknown): StreamInfo | null {
  const data = extractDataArray(json);
  if (data === null || data.length === 0) return null;

  const first = data[0];
  if (typeof first !== "object" || first === null) return null;
  const record = first as Record<string, unknown>;

  const title = typeof record.title === "string" ? record.title : "";
  const category = typeof record.game_name === "string" ? record.game_name : "";
  if (title === "" && category === "") return null;

  const broadcasterId = typeof record.user_id === "string" ? record.user_id : "";
  const broadcasterLogin = typeof record.user_login === "string" ? record.user_login : "";
  const broadcasterName = typeof record.user_name === "string" ? record.user_name : "";
  const gameId = typeof record.game_id === "string" ? record.game_id : "";
  const viewerCount = typeof record.viewer_count === "number" ? record.viewer_count : null;
  return { title, category, broadcasterId, broadcasterLogin, broadcasterName, gameId, viewerCount };
}

/**
 * Helix プロキシ(`/api/twitch/streams`)から、指定したチャンネル(user_login)の
 * ライブ配信のタイトル・カテゴリを取得する。
 *
 * 取得できない場合は null を返す(呼び出し側は文脈なしの現行プロンプトで動作する。意図した仕様):
 * - オフライン(レスポンスの `data` が空)
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害などの HTTP エラー
 * - ネットワークエラー
 */
export async function fetchStreamInfo(
  userLogin: string,
  fetchFn: typeof fetch = fetch,
): Promise<StreamInfo | null> {
  const json = await fetchHelixJson("streams", {
    params: new URLSearchParams({ user_login: userLogin }),
    fetchFn,
    failureLog: { subject: "配信情報", fallback: "文脈なしで動作します" },
  });
  if (json === null) return null;
  return parseStreamInfo(json);
}
