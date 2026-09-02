/**
 * src/lib/twitch/channel-search.ts(チャンネル検索)のテスト。
 *
 * Helix の Search Channels API(`GET /search/channels?query=`)のレスポンスを
 * チャンネル候補(login・表示名・ライブ状態)として解析する処理と、
 * Next.js プロキシ(`/api/twitch/search/channels`)経由の取得を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchChannelSuggestions, parseChannelSuggestions } from "./channel-search";

/** Helix Search Channels API のレスポンス(検証に使う部分のみ) */
function createHelixSearchJson(): unknown {
  return {
    data: [
      {
        broadcaster_login: "zackrawrr",
        display_name: "ZackRawrr",
        is_live: true,
        game_name: "World of Warcraft",
      },
      {
        broadcaster_login: "zackfair",
        display_name: "ザックス",
        is_live: false,
        game_name: "",
      },
    ],
  };
}

describe("parseChannelSuggestions", () => {
  it("レスポンスから候補一覧(login・表示名・ライブ状態)を順序どおり取り出す", () => {
    expect(parseChannelSuggestions(createHelixSearchJson())).toEqual([
      { login: "zackrawrr", displayName: "ZackRawrr", isLive: true },
      { login: "zackfair", displayName: "ザックス", isLive: false },
    ]);
  });

  it("data が空の場合は空配列を返す", () => {
    expect(parseChannelSuggestions({ data: [] })).toEqual([]);
  });

  it("login が無い項目・型が想定と異なる項目は読み飛ばす", () => {
    const json = {
      data: [
        { display_name: "loginなし", is_live: false },
        "文字列の項目",
        { broadcaster_login: "valid_user", display_name: "ValidUser", is_live: false },
      ],
    };
    expect(parseChannelSuggestions(json)).toEqual([
      { login: "valid_user", displayName: "ValidUser", isLive: false },
    ]);
  });

  it("display_name が無い項目は login を表示名として使う", () => {
    const json = { data: [{ broadcaster_login: "no_display", is_live: true }] };
    expect(parseChannelSuggestions(json)).toEqual([
      { login: "no_display", displayName: "no_display", isLive: true },
    ]);
  });

  it("data が配列でない・オブジェクトでない JSON は空配列を返す", () => {
    expect(parseChannelSuggestions({ data: "壊れたレスポンス" })).toEqual([]);
    expect(parseChannelSuggestions(null)).toEqual([]);
  });
});

describe("fetchChannelSuggestions", () => {
  it("プロキシへ query をエンコードして問い合わせ、候補一覧を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(createHelixSearchJson()), { status: 200 }),
    );

    const suggestions = await fetchChannelSuggestions("ざっく らー", { fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      "/api/twitch/search/channels?query=%E3%81%96%E3%81%A3%E3%81%8F+%E3%82%89%E3%83%BC&first=8",
      { signal: undefined },
    );
    expect(suggestions).toEqual([
      { login: "zackrawrr", displayName: "ZackRawrr", isLive: true },
      { login: "zackfair", displayName: "ザックス", isLive: false },
    ]);
  });

  it("AbortSignal を fetch に引き渡す(入力の変化で前のリクエストを中断できる)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const controller = new AbortController();

    await fetchChannelSuggestions("zack", { fetchFn, signal: controller.signal });

    expect(fetchFn).toHaveBeenCalledWith(expect.any(String), { signal: controller.signal });
  });

  it("HTTP エラー(Helix 未設定の 503 など)の場合は null を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "Helix API が設定されていません" }), { status: 503 }),
    );

    expect(await fetchChannelSuggestions("zack", { fetchFn })).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("network error"));

    expect(await fetchChannelSuggestions("zack", { fetchFn })).toBeNull();
  });

  it("中断(AbortError)の場合はエラーを握りつぶして null を返す", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError"));

    expect(await fetchChannelSuggestions("zack", { fetchFn })).toBeNull();
  });
});
