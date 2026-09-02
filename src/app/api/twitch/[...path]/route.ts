/**
 * Twitch Helix API を中継する Next.js Route Handler(プロキシ)。
 *
 * 視聴者にログインを求めず公開データ系の Helix API を使うため、
 * サーバーサイドで App Access Token(`helix-token.ts`)を付与して中継する。
 * Client ID / Client Secret / トークンはブラウザに一切露出しない。
 *
 * - GET のみ対応(公開データの取得のみが目的のため)
 * - Helix のレート制限(App Access Token で 800 req/min)を第三者に浪費されないよう、
 *   中継先エンドポイントは許可リスト(`ALLOWED_ENDPOINTS`)で制限する。
 *   新しいエンドポイントが必要になったら許可リストに追加する
 * - 429(レート制限)は Retry-After ヘッダー付きでそのまま返し、
 *   クライアント側で待機・再試行できるようにする
 * - 401(トークン失効)はトークンキャッシュを破棄して1回だけ再試行する
 * - 環境変数未設定時は 503 を返す。クライアント側はこれを「Helix 利用不可」として
 *   扱い、既存機能(IRC 接続・翻訳・Pick up)はそのまま動作させること
 */
import {
  getAppAccessToken,
  invalidateAppAccessToken,
  HelixTokenError,
} from "@/lib/twitch/helix-token";

/** Helix API のベース URL */
const HELIX_BASE_URL = "https://api.twitch.tv/helix";

/**
 * 中継を許可する Helix エンドポイント(先頭パス)の一覧。
 * すべて App Access Token で取得できる公開データ系のみを載せること。
 */
const ALLOWED_ENDPOINTS: ReadonlySet<string> = new Set([
  "users",
  "streams",
  "channels",
  "bits/cheermotes",
  "chat/emotes",
  "search/channels",
  "chat/badges",
  "chat/badges/global",
]);

/** エラーレスポンス(JSON)を組み立てる */
function errorResponse(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await ctx.params;
  const endpoint = path.join("/");
  if (!ALLOWED_ENDPOINTS.has(endpoint)) {
    return errorResponse(404, `未対応のエンドポイントです: ${endpoint}`);
  }

  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) {
    return errorResponse(503, "Helix API が設定されていません");
  }

  const { search } = new URL(request.url);
  const helixUrl = `${HELIX_BASE_URL}/${endpoint}${search}`;

  try {
    let helixResponse = await fetchHelix(helixUrl, clientId);
    if (helixResponse.status === 401) {
      // トークン失効とみなしてキャッシュを破棄し、1回だけ再試行する
      invalidateAppAccessToken();
      helixResponse = await fetchHelix(helixUrl, clientId);
      if (helixResponse.status === 401) {
        return errorResponse(502, "Helix API の認証に失敗しました");
      }
    }
    if (helixResponse.status === 429) {
      const headers = new Headers({ "Content-Type": "application/json" });
      const retryAfter = helixResponse.headers.get("Retry-After");
      if (retryAfter !== null) {
        headers.set("Retry-After", retryAfter);
      }
      return new Response(
        JSON.stringify({ error: "Helix API のレート制限に達しました" }),
        { status: 429, headers },
      );
    }
    // 成功・その他の 4xx はステータスとボディをそのまま返す
    return new Response(helixResponse.body, {
      status: helixResponse.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof HelixTokenError && error.kind === "not_configured") {
      return errorResponse(503, "Helix API が設定されていません");
    }
    return errorResponse(502, "Helix API への中継に失敗しました");
  }
}

/** App Access Token を付与して Helix API へ GET リクエストを送る */
async function fetchHelix(url: string, clientId: string): Promise<Response> {
  const token = await getAppAccessToken();
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": clientId,
    },
  });
}
