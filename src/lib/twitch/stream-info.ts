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

/** 接続中チャンネルのライブ配信の情報。カテゴリ未設定の配信では category が空文字になる */
export interface StreamInfo {
  /** 配信タイトル(Helix の `title`) */
  title: string;
  /** 配信カテゴリ = ゲーム名(Helix の `game_name`) */
  category: string;
}

/**
 * Helix の Get Streams API レスポンス(`{data: [{title, game_name, ...}]}`)を解析して
 * StreamInfo を作る。オフライン(`data` が空)・形式が想定と異なる場合・
 * タイトルとカテゴリの両方が空の場合(文脈として意味が無い)は null を返す。
 */
export function parseStreamInfo(json: unknown): StreamInfo | null {
  if (typeof json !== "object" || json === null) return null;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length === 0) return null;

  const first = data[0];
  if (typeof first !== "object" || first === null) return null;
  const record = first as Record<string, unknown>;

  const title = typeof record.title === "string" ? record.title : "";
  const category = typeof record.game_name === "string" ? record.game_name : "";
  if (title === "" && category === "") return null;
  return { title, category };
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
  try {
    const response = await fetchFn(`/api/twitch/streams?user_login=${encodeURIComponent(userLogin)}`);
    if (!response.ok) {
      console.warn(`配信情報の取得に失敗しました(HTTP ${response.status})。文脈なしで動作します`);
      return null;
    }
    return parseStreamInfo(await response.json());
  } catch (error) {
    console.warn("配信情報の取得に失敗しました。文脈なしで動作します", error);
    return null;
  }
}
