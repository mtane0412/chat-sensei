/**
 * Helix API プロキシ Route Handler のテスト。
 *
 * - 許可リスト内のエンドポイントへ App Access Token 付きで中継すること
 * - Client Secret / トークンをブラウザに露出させないこと(レスポンスは Helix の JSON のみ)
 * - 401(トークン失効)でトークンを破棄して1回だけ再試行すること
 * - 429(レート制限)を Retry-After 付きでそのまま返すこと
 * - 環境変数未設定時は 503 を返し、クライアント側でフォールバックできること
 * を検証する。外部依存(fetch・トークンモジュール)はモックする。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GET } from "./route";
import { HelixTokenError } from "@/lib/twitch/helix-token";

const getAppAccessTokenMock = vi.fn();
const invalidateAppAccessTokenMock = vi.fn();

vi.mock("@/lib/twitch/helix-token", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/twitch/helix-token")>();
  return {
    ...original,
    getAppAccessToken: (...args: unknown[]) => getAppAccessTokenMock(...args),
    invalidateAppAccessToken: (...args: unknown[]) =>
      invalidateAppAccessTokenMock(...args),
  };
});

/** Route Handler を呼び出すヘルパー */
function callGet(pathSegments: string[], query = "") {
  const url = `https://example.com/api/twitch/${pathSegments.join("/")}${query}`;
  return GET(new Request(url), {
    params: Promise.resolve({ path: pathSegments }),
  });
}

/** Helix API のレスポンスを組み立てるヘルパー */
function helixResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
  });
}

describe("GET /api/twitch/[...path]", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("TWITCH_CLIENT_ID", "test-client-id");
    fetchMock.mockReset();
    getAppAccessTokenMock.mockReset();
    invalidateAppAccessTokenMock.mockReset();
    getAppAccessTokenMock.mockResolvedValue("test-app-token");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("許可リスト内のエンドポイントへクエリ付きで中継し、Helix の JSON を返す", async () => {
    const helixBody = { data: [{ id: "12345", login: "example_user" }] };
    fetchMock.mockResolvedValueOnce(helixResponse(helixBody));

    const response = await callGet(["users"], "?login=example_user");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(helixBody);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.twitch.tv/helix/users?login=example_user");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer test-app-token");
    expect(headers.get("Client-Id")).toBe("test-client-id");
  });

  it("チャンネル検索(search/channels)も中継できる", async () => {
    fetchMock.mockResolvedValueOnce(helixResponse({ data: [] }));

    const response = await callGet(["search", "channels"], "?query=zack");

    expect(response.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.twitch.tv/helix/search/channels?query=zack");
  });

  it("複数セグメントのエンドポイント(bits/cheermotes)も中継できる", async () => {
    fetchMock.mockResolvedValueOnce(helixResponse({ data: [] }));

    const response = await callGet(
      ["bits", "cheermotes"],
      "?broadcaster_id=12345",
    );

    expect(response.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(
      "https://api.twitch.tv/helix/bits/cheermotes?broadcaster_id=12345",
    );
  });

  it("チャットバッジ(chat/badges・chat/badges/global)も中継できる", async () => {
    fetchMock.mockResolvedValue(helixResponse({ data: [] }));

    const channelResponse = await callGet(["chat", "badges"], "?broadcaster_id=12345");
    const globalResponse = await callGet(["chat", "badges", "global"]);

    expect(channelResponse.status).toBe(200);
    expect(globalResponse.status).toBe(200);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.twitch.tv/helix/chat/badges?broadcaster_id=12345",
      "https://api.twitch.tv/helix/chat/badges/global",
    ]);
  });

  it("ゲーム情報(games)も中継できる(ボックスアート取得用)", async () => {
    fetchMock.mockResolvedValue(helixResponse({ data: [] }));

    const response = await callGet(["games"], "?id=18122");

    expect(response.status).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://api.twitch.tv/helix/games?id=18122");
  });

  it("許可リストにないエンドポイントは 404 を返し、Helix へ中継しない", async () => {
    const response = await callGet(["moderation", "banned"]);

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Helix が 401 を返したらトークンを破棄して1回だけ再試行する", async () => {
    const helixBody = { data: [{ id: "12345" }] };
    fetchMock
      .mockResolvedValueOnce(helixResponse({ message: "expired" }, 401))
      .mockResolvedValueOnce(helixResponse(helixBody));

    const response = await callGet(["users"], "?login=example_user");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(helixBody);
    expect(invalidateAppAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("再試行後も 401 の場合はそれ以上再試行せず 502 を返す", async () => {
    fetchMock.mockResolvedValue(helixResponse({ message: "expired" }, 401));

    const response = await callGet(["users"]);

    expect(response.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Helix が 429 を返したら Retry-After 付きで 429 を返す", async () => {
    fetchMock.mockResolvedValueOnce(
      helixResponse({ message: "Too Many Requests" }, 429, {
        "Retry-After": "30",
      }),
    );

    const response = await callGet(["streams"]);

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("環境変数未設定(not_configured)の場合は 503 を返す", async () => {
    getAppAccessTokenMock.mockRejectedValue(
      new HelixTokenError("not_configured", "未設定"),
    );

    const response = await callGet(["users"]);

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("トークン取得リクエストの失敗(request_failed)の場合は 502 を返す", async () => {
    getAppAccessTokenMock.mockRejectedValue(
      new HelixTokenError("request_failed", "取得失敗"),
    );

    const response = await callGet(["users"]);

    expect(response.status).toBe(502);
  });

  it("Helix への fetch 自体が失敗した場合は 502 を返す", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ネットワークエラー"));

    const response = await callGet(["users"]);

    expect(response.status).toBe(502);
  });

  it("Helix の 4xx エラー(400 など)はステータスとボディをそのまま返す", async () => {
    const errorBody = { error: "Bad Request", status: 400, message: "invalid" };
    fetchMock.mockResolvedValueOnce(helixResponse(errorBody, 400));

    const response = await callGet(["users"], "?id=invalid");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(errorBody);
  });
});
