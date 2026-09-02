/**
 * src/lib/twitch/stream-info.ts(配信タイトル・カテゴリの取得)のテスト。
 *
 * Helix の Get Streams API(`GET /streams?user_login=`)のレスポンスを
 * 配信情報(タイトル・カテゴリ)として解析する処理と、
 * Next.js プロキシ(`/api/twitch/streams`)経由の取得を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchStreamInfo, parseStreamInfo } from "./stream-info";

/** Helix Get Streams API のライブ配信 1 件ぶんのレスポンス(検証に使う部分のみ) */
function createHelixStreamsJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: [
      {
        user_login: "zackrawrr",
        type: "live",
        title: "Mythic raid progression! !drops",
        game_name: "World of Warcraft",
        ...overrides,
      },
    ],
  };
}

describe("parseStreamInfo", () => {
  it("ライブ配信のレスポンスからタイトルとカテゴリを取り出す", () => {
    expect(parseStreamInfo(createHelixStreamsJson())).toEqual({
      title: "Mythic raid progression! !drops",
      category: "World of Warcraft",
    });
  });

  it("data が空(オフライン)の場合は null を返す", () => {
    expect(parseStreamInfo({ data: [] })).toBeNull();
  });

  it("カテゴリ未設定(game_name が空文字)の場合はタイトルだけを保持する", () => {
    expect(parseStreamInfo(createHelixStreamsJson({ game_name: "" }))).toEqual({
      title: "Mythic raid progression! !drops",
      category: "",
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

describe("fetchStreamInfo", () => {
  it("Helix プロキシに user_login 付きで GET し、解析した配信情報を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(createHelixStreamsJson()));

    const info = await fetchStreamInfo("zackrawrr", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/streams?user_login=zackrawrr");
    expect(info).toEqual({ title: "Mythic raid progression! !drops", category: "World of Warcraft" });
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
