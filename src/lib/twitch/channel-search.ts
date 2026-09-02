/**
 * チャンネル名入力のオートコンプリート用のチャンネル検索(issue #59)。
 *
 * Helix の Search Channels API(`GET /search/channels?query=`)を Next.js プロキシ
 * (`/api/twitch/`)経由で呼び、入力文字列に一致するチャンネル候補
 * (login・表示名・ライブ状態)を取得する。ホーム画面の Channel 入力欄
 * (`src/components/channel-autocomplete.tsx`)がデバウンス付きで利用する。
 *
 * - 入力の変化で前のリクエストが不要になるため、`AbortSignal` を受け取って中断できるようにする
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害・ネットワークエラー・中断は
 *   null を返し、候補なし(現行の手入力だけの動作)にフォールバックする(意図した仕様)
 */

import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** チャンネル候補 1 件(Helix Search Channels API の 1 項目) */
export interface ChannelSuggestion {
  /** 接続に使うログイン名(Helix の `broadcaster_login`) */
  login: string;
  /** 表示名(Helix の `display_name`。日本語名など)。無ければ login と同じ値 */
  displayName: string;
  /** ライブ配信中か(Helix の `is_live`) */
  isLive: boolean;
}

/** 1 回の検索で取得する候補の最大件数(Helix の `first` パラメータ) */
const SUGGESTION_LIMIT = 8;

/**
 * Helix の Search Channels API レスポンス(`{data: [{broadcaster_login, display_name, is_live, ...}]}`)を
 * 解析してチャンネル候補一覧を作る。API 側の仕様変更などで形式が想定と異なる項目は読み飛ばす。
 */
export function parseChannelSuggestions(json: unknown): ChannelSuggestion[] {
  const data = extractDataArray(json);
  if (data === null) return [];

  const suggestions: ChannelSuggestion[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.broadcaster_login !== "string" || record.broadcaster_login === "") continue;

    suggestions.push({
      login: record.broadcaster_login,
      displayName:
        typeof record.display_name === "string" && record.display_name !== ""
          ? record.display_name
          : record.broadcaster_login,
      isLive: record.is_live === true,
    });
  }
  return suggestions;
}

/**
 * Helix プロキシ(`/api/twitch/search/channels`)から、入力文字列に一致する
 * チャンネル候補一覧を取得する。
 *
 * 取得できない場合は null を返す(呼び出し側は候補を表示しない。意図した仕様):
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害などの HTTP エラー
 * - ネットワークエラー・`signal` による中断(AbortError)
 */
export async function fetchChannelSuggestions(
  query: string,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<ChannelSuggestion[] | null> {
  const { signal, fetchFn = fetch } = options;
  // failureLog を渡さない = 失敗しても console.warn しない(中断・ネットワークエラーを候補なしとして静かに扱う)
  const json = await fetchHelixJson("search/channels", {
    params: new URLSearchParams({ query, first: String(SUGGESTION_LIMIT) }),
    fetchFn,
    signal,
  });
  if (json === null) return null;
  return parseChannelSuggestions(json);
}
