/**
 * Twitch App Access Token(Client Credentials フロー)の取得・キャッシュを行う
 * サーバーサイド専用モジュール。
 *
 * - `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` は Client Secret を含むため、
 *   Route Handler などサーバーサイドからのみ import すること
 *   (`NEXT_PUBLIC_` を付けず、ブラウザへは絶対に露出させない)
 * - App Access Token は約60日有効なため、モジュールスコープでキャッシュして使い回す。
 *   Vercel の Fluid Compute ではインスタンスがリクエスト間で再利用されるため、
 *   モジュールスコープのキャッシュが有効に機能する(インスタンスが破棄された場合は
 *   再取得されるだけで正しく動く)
 * - 同時リクエストで取得が重ならないよう、進行中の取得 Promise を共有する
 * - Helix 側で 401 が返った場合(トークン失効)は `invalidateAppAccessToken` で
 *   キャッシュを破棄して再取得させる
 */

/** トークン取得エンドポイント */
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";

/**
 * 有効期限手前でトークンを再取得するためのマージン(秒)。
 * 期限ぎりぎりのトークンで Helix を呼んで 401 になるのを避ける。
 */
const EXPIRY_MARGIN_SECONDS = 300;

/** トークン取得に失敗した理由の分類 */
export type HelixTokenErrorKind = "not_configured" | "request_failed";

/**
 * トークン取得の失敗を表すエラー。
 * `kind` により「環境変数未設定(設定不備)」と「取得リクエスト失敗」を区別できる。
 */
export class HelixTokenError extends Error {
  readonly kind: HelixTokenErrorKind;

  constructor(kind: HelixTokenErrorKind, message: string) {
    super(message);
    this.name = "HelixTokenError";
    this.kind = kind;
  }
}

/** キャッシュ中のトークンと有効期限(エポックミリ秒) */
interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

let cachedToken: CachedToken | null = null;
let inFlight: Promise<string> | null = null;

/**
 * App Access Token を取得する。
 * キャッシュが有効ならそれを返し、なければ Twitch から新規取得する。
 *
 * @throws HelixTokenError 環境変数未設定、または取得リクエスト失敗時
 */
export async function getAppAccessToken(): Promise<string> {
  if (cachedToken !== null && Date.now() < cachedToken.expiresAtMs) {
    return cachedToken.accessToken;
  }
  if (inFlight !== null) {
    return inFlight;
  }
  inFlight = fetchNewToken().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * キャッシュ中のトークンを破棄する。
 * Helix API が 401 を返した場合(トークン失効)に呼び、次回取得時に再発行させる。
 */
export function invalidateAppAccessToken(): void {
  cachedToken = null;
}

/** Twitch のトークンエンドポイントから新しいトークンを取得してキャッシュする */
async function fetchNewToken(): Promise<string> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HelixTokenError(
      "not_configured",
      "TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET が設定されていません",
    );
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) {
    throw new HelixTokenError(
      "request_failed",
      `App Access Token の取得に失敗しました(status: ${response.status})`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs:
      Date.now() + Math.max(0, data.expires_in - EXPIRY_MARGIN_SECONDS) * 1000,
  };
  return data.access_token;
}
