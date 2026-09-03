/**
 * src/lib/twitch/stream-info.ts(配信タイトル・カテゴリなど配信情報の取得)のテスト。
 *
 * Helix の Get Streams API(`GET /streams?user_login=`)のレスポンスを
 * 配信情報(タイトル・カテゴリ・配信者情報・視聴者数)として解析する処理と、
 * Next.js プロキシ(`/api/twitch/streams`)経由の取得を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchStreamInfo, fetchStreamInfoResult, parseStreamInfo } from "./stream-info";

/** Helix Get Streams API のライブ配信 1 件ぶんのレスポンス(検証に使う部分のみ) */
function createHelixStreamsJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: [
      {
        user_id: "552120296",
        user_login: "zackrawrr",
        user_name: "ZackRawrr",
        type: "live",
        title: "Mythic raid progression! !drops",
        game_id: "18122",
        game_name: "World of Warcraft",
        viewer_count: 4321,
        ...overrides,
      },
    ],
  };
}

/** 全フィールドが取得できたときの期待値 */
const 期待する配信情報 = {
  title: "Mythic raid progression! !drops",
  category: "World of Warcraft",
  broadcasterId: "552120296",
  broadcasterLogin: "zackrawrr",
  broadcasterName: "ZackRawrr",
  gameId: "18122",
  viewerCount: 4321,
};

describe("parseStreamInfo", () => {
  it("ライブ配信のレスポンスからタイトル・カテゴリ・配信者情報(ID / username / DisplayName)・ゲームID・視聴者数を取り出す", () => {
    expect(parseStreamInfo(createHelixStreamsJson())).toEqual(期待する配信情報);
  });

  it("data が空(オフライン)の場合は null を返す", () => {
    expect(parseStreamInfo({ data: [] })).toBeNull();
  });

  it("カテゴリ未設定(game_name が空文字)の場合はカテゴリを空文字として保持する", () => {
    expect(parseStreamInfo(createHelixStreamsJson({ game_name: "" }))).toEqual({
      ...期待する配信情報,
      category: "",
    });
  });

  it("配信者名のフィールドが無い・型が違う場合は空文字として保持する(タイトル・カテゴリがあれば文脈は成立する)", () => {
    expect(
      parseStreamInfo(createHelixStreamsJson({ user_id: undefined, user_login: undefined, user_name: 123 })),
    ).toEqual({
      ...期待する配信情報,
      broadcasterId: "",
      broadcasterLogin: "",
      broadcasterName: "",
    });
  });

  it("ゲームID が無い・型が違う場合は空文字として保持する(ボックスアートを表示しないだけ)", () => {
    expect(parseStreamInfo(createHelixStreamsJson({ game_id: 18122 }))).toEqual({
      ...期待する配信情報,
      gameId: "",
    });
  });

  it("視聴者数が無い・型が違う場合は null として保持する(視聴者数を表示しないだけ)", () => {
    expect(parseStreamInfo(createHelixStreamsJson({ viewer_count: "many" }))).toEqual({
      ...期待する配信情報,
      viewerCount: null,
    });
  });

  it("タイトルとカテゴリの両方が空の場合は null を返す(文脈として意味が無いため)", () => {
    expect(parseStreamInfo(createHelixStreamsJson({ title: "", game_name: "" }))).toBeNull();
  });

  it("形式が想定と異なるレスポンス(data が配列でない・フィールドの型が違う)は null を返す", () => {
    expect(parseStreamInfo(null)).toBeNull();
    expect(parseStreamInfo({})).toBeNull();
    expect(parseStreamInfo({ data: "not-an-array" })).toBeNull();
    expect(parseStreamInfo({ data: [{ title: 123, game_name: 456 }] })).toBeNull();
  });
});

describe("fetchStreamInfoResult", () => {
  it("ライブ配信中は live ステータスと解析した配信情報を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(createHelixStreamsJson()));

    const result = await fetchStreamInfoResult("zackrawrr", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/streams?user_login=zackrawrr", { signal: undefined });
    expect(result).toEqual({ status: "live", info: 期待する配信情報 });
  });

  it("オフライン(data が空)の場合は offline ステータスを返す(配信終了の検知に使う)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));

    expect(await fetchStreamInfoResult("zackrawrr", fetchFn)).toEqual({ status: "offline" });
  });

  it("HTTP エラー(503: Helix 未設定など)の場合は unavailable ステータスを返す(オフラインと区別する)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ error: "Helix API が設定されていません" }, { status: 503 }));

    expect(await fetchStreamInfoResult("zackrawrr", fetchFn)).toEqual({ status: "unavailable" });
  });

  it("ネットワークエラーの場合は unavailable ステータスを返す", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    expect(await fetchStreamInfoResult("zackrawrr", fetchFn)).toEqual({ status: "unavailable" });
  });
});

describe("fetchStreamInfo", () => {
  it("Helix プロキシに user_login 付きで GET し、解析した配信情報を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(createHelixStreamsJson()));

    const info = await fetchStreamInfo("zackrawrr", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/streams?user_login=zackrawrr", { signal: undefined });
    expect(info).toEqual(期待する配信情報);
  });

  it("オフライン(data が空)の場合は null を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));

    expect(await fetchStreamInfo("zackrawrr", fetchFn)).toBeNull();
  });

  it("HTTP エラー(503: Helix 未設定など)の場合は null を返す(文脈なしで動作を続けるため)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ error: "Helix API が設定されていません" }, { status: 503 }));

    expect(await fetchStreamInfo("zackrawrr", fetchFn)).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    expect(await fetchStreamInfo("zackrawrr", fetchFn)).toBeNull();
  });
});
