/**
 * src/lib/twitch/user-avatars.ts(発言者のプロフィール画像 URL の取得)のテスト。
 *
 * Helix の Get Users API(`GET /users?id=`)のレスポンスを
 * 「ユーザー ID → プロフィール画像 URL」の対応表として解析する処理と、
 * Next.js プロキシ(`/api/twitch/users`)経由のバッチ取得(1 リクエスト最大 100 件)を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchUserAvatars, parseUserAvatars } from "./user-avatars";

/** Helix Get Users API のレスポンス(検証に使う部分のみ) */
function createHelixUsersJson(): unknown {
  return {
    data: [
      { id: "1234", login: "viewer_taro", profile_image_url: "https://cdn.example/taro.png" },
      { id: "5678", login: "viewer_hanako", profile_image_url: "https://cdn.example/hanako.png" },
    ],
  };
}

describe("parseUserAvatars", () => {
  it("レスポンスから「ユーザー ID → プロフィール画像 URL」の対応表を作る", () => {
    expect(parseUserAvatars(createHelixUsersJson())).toEqual(
      new Map([
        ["1234", "https://cdn.example/taro.png"],
        ["5678", "https://cdn.example/hanako.png"],
      ]),
    );
  });

  it("id や profile_image_url が無い・空文字の項目は読み飛ばす", () => {
    const json = {
      data: [
        { id: "1", profile_image_url: "" },
        { id: "2" },
        { profile_image_url: "https://cdn.example/no-id.png" },
        { id: "3", profile_image_url: "https://cdn.example/valid.png" },
      ],
    };
    expect(parseUserAvatars(json)).toEqual(new Map([["3", "https://cdn.example/valid.png"]]));
  });

  it("data が配列でない・オブジェクトでない JSON は空の対応表を返す", () => {
    expect(parseUserAvatars({ data: "壊れたレスポンス" })).toEqual(new Map());
    expect(parseUserAvatars(null)).toEqual(new Map());
  });
});

describe("fetchUserAvatars", () => {
  it("プロキシへ id をクエリで並べて問い合わせ、対応表を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createHelixUsersJson()), { status: 200 }),
    );

    const avatars = await fetchUserAvatars(["1234", "5678"], fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/users?id=1234&id=5678");
    expect(avatars).toEqual(
      new Map([
        ["1234", "https://cdn.example/taro.png"],
        ["5678", "https://cdn.example/hanako.png"],
      ]),
    );
  });

  it("100 件を超える ID は 100 件ずつのリクエストに分割する(Helix の上限)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    await fetchUserAvatars(ids, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const firstUrl = (fetchFn.mock.calls[0] as [string])[0];
    const secondUrl = (fetchFn.mock.calls[1] as [string])[0];
    expect(firstUrl.match(/id=/g)).toHaveLength(100);
    expect(secondUrl.match(/id=/g)).toHaveLength(50);
  });

  it("重複する ID は 1 件にまとめて問い合わせる", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createHelixUsersJson()), { status: 200 }),
    );

    await fetchUserAvatars(["1234", "1234", "5678"], fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/users?id=1234&id=5678");
  });

  it("ID が空の場合はリクエストせず空の対応表を返す", async () => {
    const fetchFn = vi.fn();

    expect(await fetchUserAvatars([], fetchFn)).toEqual(new Map());
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("一部のチャンクだけが失敗した場合は、成功したチャンクぶんの対応表を返す(取得済みを捨てない)", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => String(i + 1));
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "1", profile_image_url: "https://cdn.example/1.png" }] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Too Many Requests" }), { status: 429 }));

    const avatars = await fetchUserAvatars(ids, fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(avatars).toEqual(new Map([["1", "https://cdn.example/1.png"]]));
  });

  it("HTTP エラー(Helix 未設定の 503 など)の場合は null を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Helix API が設定されていません" }), { status: 503 }),
    );

    expect(await fetchUserAvatars(["1234"], fetchFn)).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("network error"));

    expect(await fetchUserAvatars(["1234"], fetchFn)).toBeNull();
  });
});
