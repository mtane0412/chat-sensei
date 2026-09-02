/**
 * src/lib/twitch/badges.ts(チャットバッジの画像 URL 対応表)のテスト。
 *
 * Helix の Chat Badges API(`GET /chat/badges/global` と `GET /chat/badges?broadcaster_id=`)の
 * レスポンスを「set_id/version → 画像 URL」の対応表として解析する処理と、
 * Next.js プロキシ経由でグローバル + チャンネル固有を取得してマージ
 * (同じ set_id はチャンネル固有を優先)する処理を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchBadgeImageMap, parseBadgeImageMap } from "./badges";

/** Helix Chat Badges API のグローバルバッジのレスポンス(検証に使う部分のみ) */
const グローバルバッジJSON = {
  data: [
    {
      set_id: "moderator",
      versions: [{ id: "1", image_url_2x: "https://cdn.example/global/moderator/1/2x.png" }],
    },
    {
      set_id: "subscriber",
      versions: [
        { id: "0", image_url_2x: "https://cdn.example/global/subscriber/0/2x.png" },
        { id: "3", image_url_2x: "https://cdn.example/global/subscriber/3/2x.png" },
      ],
    },
  ],
};

/** チャンネル固有バッジのレスポンス(サブスクバッジをチャンネル独自画像で上書きする) */
const チャンネルバッジJSON = {
  data: [
    {
      set_id: "subscriber",
      versions: [{ id: "0", image_url_2x: "https://cdn.example/channel/subscriber/0/2x.png" }],
    },
  ],
};

describe("parseBadgeImageMap", () => {
  it("レスポンスから「set_id/version → 画像 URL」の対応表を作る", () => {
    expect(parseBadgeImageMap(グローバルバッジJSON)).toEqual(
      new Map([
        ["moderator/1", "https://cdn.example/global/moderator/1/2x.png"],
        ["subscriber/0", "https://cdn.example/global/subscriber/0/2x.png"],
        ["subscriber/3", "https://cdn.example/global/subscriber/3/2x.png"],
      ]),
    );
  });

  it("set_id・versions・画像 URL が無い項目・型が想定と異なる項目は読み飛ばす", () => {
    const json = {
      data: [
        { versions: [{ id: "1", image_url_2x: "https://cdn.example/no-set-id.png" }] },
        { set_id: "broken", versions: "配列でない" },
        { set_id: "no-url", versions: [{ id: "1" }] },
        { set_id: "vip", versions: [{ id: "1", image_url_2x: "https://cdn.example/vip/1/2x.png" }] },
      ],
    };
    expect(parseBadgeImageMap(json)).toEqual(new Map([["vip/1", "https://cdn.example/vip/1/2x.png"]]));
  });

  it("data が配列でない・オブジェクトでない JSON は空の対応表を返す", () => {
    expect(parseBadgeImageMap({ data: "壊れたレスポンス" })).toEqual(new Map());
    expect(parseBadgeImageMap(null)).toEqual(new Map());
  });
});

describe("fetchBadgeImageMap", () => {
  /** URL に応じてグローバル・チャンネルのレスポンスを返すフェイク fetch */
  function createFetchFn(
    globalResult: { status: number; body: unknown } | Error,
    channelResult: { status: number; body: unknown } | Error,
  ) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const result = String(input).includes("/chat/badges/global") ? globalResult : channelResult;
      if (result instanceof Error) throw result;
      return new Response(JSON.stringify(result.body), { status: result.status });
    });
  }

  it("グローバルとチャンネル固有をマージし、同じ set_id/version はチャンネル固有を優先する", async () => {
    const fetchFn = createFetchFn(
      { status: 200, body: グローバルバッジJSON },
      { status: 200, body: チャンネルバッジJSON },
    );

    const map = await fetchBadgeImageMap("12345", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/chat/badges/global");
    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/chat/badges?broadcaster_id=12345");
    expect(map).toEqual(
      new Map([
        ["moderator/1", "https://cdn.example/global/moderator/1/2x.png"],
        // subscriber/0 はチャンネル固有画像で上書きされる
        ["subscriber/0", "https://cdn.example/channel/subscriber/0/2x.png"],
        ["subscriber/3", "https://cdn.example/global/subscriber/3/2x.png"],
      ]),
    );
  });

  it("チャンネル固有だけが取得できない場合は、グローバルだけの対応表を返す", async () => {
    const fetchFn = createFetchFn(
      { status: 200, body: グローバルバッジJSON },
      { status: 500, body: { error: "server error" } },
    );

    const map = await fetchBadgeImageMap("12345", fetchFn);

    expect(map).toEqual(parseBadgeImageMap(グローバルバッジJSON));
  });

  it("グローバルだけが取得できない場合は、チャンネル固有だけの対応表を返す", async () => {
    const fetchFn = createFetchFn(new TypeError("network error"), {
      status: 200,
      body: チャンネルバッジJSON,
    });

    const map = await fetchBadgeImageMap("12345", fetchFn);

    expect(map).toEqual(new Map([["subscriber/0", "https://cdn.example/channel/subscriber/0/2x.png"]]));
  });

  it("両方とも取得できない場合(Helix 未設定の 503 など)は null を返す", async () => {
    const fetchFn = createFetchFn(
      { status: 503, body: { error: "Helix API が設定されていません" } },
      { status: 503, body: { error: "Helix API が設定されていません" } },
    );

    expect(await fetchBadgeImageMap("12345", fetchFn)).toBeNull();
  });
});
