/**
 * helix-token.ts のテスト。
 *
 * Twitch App Access Token(Client Credentials フロー)の取得・キャッシュを検証する。
 * 外部依存(fetch・環境変数)はモックする。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getAppAccessToken,
  invalidateAppAccessToken,
  HelixTokenError,
} from "./helix-token";

/** fetch モックが返すトークンレスポンスを組み立てるヘルパー */
function tokenResponse(accessToken: string, expiresIn = 5_000_000) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      access_token: accessToken,
      expires_in: expiresIn,
      token_type: "bearer",
    }),
  } as Response;
}

describe("getAppAccessToken", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TWITCH_CLIENT_ID", "テスト用クライアントID");
    vi.stubEnv("TWITCH_CLIENT_SECRET", "テスト用シークレット");
    // モジュール内キャッシュをテストごとにリセットする
    invalidateAppAccessToken();
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("Twitch のトークンエンドポイントに client_credentials で POST してトークンを返す", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("取得したトークン"));

    const token = await getAppAccessToken();

    expect(token).toBe("取得したトークン");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://id.twitch.tv/oauth2/token");
    expect(init.method).toBe("POST");
    const body = init.body as URLSearchParams;
    expect(body.get("client_id")).toBe("テスト用クライアントID");
    expect(body.get("client_secret")).toBe("テスト用シークレット");
    expect(body.get("grant_type")).toBe("client_credentials");
  });

  it("2回目の呼び出しではキャッシュを使い、fetch を再実行しない", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("キャッシュされるトークン"));

    const first = await getAppAccessToken();
    const second = await getAppAccessToken();

    expect(first).toBe("キャッシュされるトークン");
    expect(second).toBe("キャッシュされるトークン");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同時に複数回呼ばれても fetch は1回だけ実行する(in-flight 共有)", async () => {
    fetchMock.mockResolvedValueOnce(tokenResponse("共有トークン"));

    const [a, b] = await Promise.all([
      getAppAccessToken(),
      getAppAccessToken(),
    ]);

    expect(a).toBe("共有トークン");
    expect(b).toBe("共有トークン");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("有効期限が近づいたトークンは再取得する", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(tokenResponse("古いトークン", 3600))
      .mockResolvedValueOnce(tokenResponse("新しいトークン"));

    await getAppAccessToken();
    // 有効期限(3600秒)を超えて時間を進める
    vi.advanceTimersByTime(3600 * 1000 + 1);
    const token = await getAppAccessToken();

    expect(token).toBe("新しいトークン");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidateAppAccessToken でキャッシュを破棄すると再取得する", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenResponse("破棄されるトークン"))
      .mockResolvedValueOnce(tokenResponse("再取得したトークン"));

    await getAppAccessToken();
    invalidateAppAccessToken();
    const token = await getAppAccessToken();

    expect(token).toBe("再取得したトークン");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("環境変数が未設定の場合は設定エラーとして HelixTokenError を投げる", async () => {
    vi.stubEnv("TWITCH_CLIENT_ID", "");
    vi.stubEnv("TWITCH_CLIENT_SECRET", "");

    await expect(getAppAccessToken()).rejects.toThrow(HelixTokenError);
    await expect(getAppAccessToken()).rejects.toMatchObject({
      kind: "not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("トークンエンドポイントがエラーを返した場合は HelixTokenError を投げる", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ message: "invalid client secret" }),
    } as Response);

    await expect(getAppAccessToken()).rejects.toMatchObject({
      kind: "request_failed",
    });
  });

  it("取得失敗後の再呼び出しでは fetch を再実行する(失敗した Promise をキャッシュしない)", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("ネットワークエラー"))
      .mockResolvedValueOnce(tokenResponse("復帰後のトークン"));

    await expect(getAppAccessToken()).rejects.toThrow();
    const token = await getAppAccessToken();

    expect(token).toBe("復帰後のトークン");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
