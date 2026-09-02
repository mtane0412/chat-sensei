/**
 * Helix プロキシ(`/api/twitch/`)呼び出しの共通ヘルパー(issue #65)。
 *
 * Helix API を Next.js プロキシ経由で呼ぶ各クライアント
 * (`stream-info.ts` / `cheermotes.ts` / `user-avatars.ts` / `channel-search.ts` / `badges.ts`)で
 * 重複していた以下の 2 つの処理を共通化する。
 *
 * - fetch ラッパー(`fetchHelixJson`): `try / fetch / !response.ok → console.warn → null /
 *   catch → null` の制御フロー。プロキシ契約の変更(例: 429 の `Retry-After` を尊重した
 *   待機・再試行の導入)はこのヘルパーだけを修正すればよい
 * - `{data: [...]}` エンベロープの前段パース(`extractDataArray`): オブジェクト判定 →
 *   `.data` 取り出し → `Array.isArray` 判定
 *
 * 各クライアント固有のレスポンス解析(フィールドの型判定など)と、null 時の
 * フォールバック方針(静的一覧・文脈なし動作など)は従来どおり各クライアントが担う。
 */

/** 取得失敗時に console.warn へ出す文言。省略した場合は警告を出さない(静かに失敗したい用途) */
export interface HelixFailureLog {
  /** 取得対象の名称(例: "配信情報")。「{subject}の取得に失敗しました」と整形される */
  subject: string;
  /** 失敗時のフォールバック動作の説明(例: "文脈なしで動作します") */
  fallback: string;
}

/** fetchHelixJson のオプション */
export interface FetchHelixJsonOptions {
  /** クエリパラメータ。繰り返しキー(`id=111&id=222`)もそのまま保持される */
  params?: URLSearchParams;
  /** テストや呼び出し側から注入する fetch 実装(省略時はグローバルの fetch) */
  fetchFn?: typeof fetch;
  /** リクエストの中断用(オートコンプリートなど) */
  signal?: AbortSignal;
  /** 取得失敗時の console.warn 文言。省略した場合は警告を出さない */
  failureLog?: HelixFailureLog;
}

/**
 * Helix プロキシ(`/api/twitch/{path}`)から JSON を取得する。
 *
 * 取得できない場合は null を返す(呼び出し側が各自のフォールバックへ移る):
 * - HTTP エラー(Helix 未設定の 503・レート制限・障害など)
 * - ネットワークエラー・`signal` による中断(AbortError)・レスポンス本文の JSON 解析失敗
 *
 * `failureLog` を渡した場合のみ、失敗時に console.warn で文言を出す。
 */
export async function fetchHelixJson(
  path: string,
  options: FetchHelixJsonOptions = {},
): Promise<unknown | null> {
  const { params, fetchFn = fetch, signal, failureLog } = options;
  const url = params === undefined ? `/api/twitch/${path}` : `/api/twitch/${path}?${params.toString()}`;
  try {
    const response = await fetchFn(url, { signal });
    if (!response.ok) {
      if (failureLog !== undefined) {
        console.warn(
          `${failureLog.subject}の取得に失敗しました(HTTP ${response.status})。${failureLog.fallback}`,
        );
      }
      return null;
    }
    return await response.json();
  } catch (error) {
    if (failureLog !== undefined) {
      console.warn(`${failureLog.subject}の取得に失敗しました。${failureLog.fallback}`, error);
    }
    return null;
  }
}

/**
 * Helix レスポンスの `{data: [...]}` エンベロープから data 配列を取り出す。
 * オブジェクトでない・`data` が配列でない場合は null を返す。
 * 空配列はそのまま返す(オフライン判定など、空の意味づけは呼び出し側の責務)。
 */
export function extractDataArray(json: unknown): readonly unknown[] | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>).data;
  return Array.isArray(data) ? data : null;
}
