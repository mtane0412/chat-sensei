/**
 * src/lib/twitch/game-box-art.ts(配信カテゴリのボックスアート URL 取得)のテスト。
 *
 * Helix の Get Games API(`GET /games?id=`)のレスポンスからボックスアート URL の
 * テンプレート(`{width}x{height}` プレースホルダ付き)を解析し、表示サイズに解決する
 * 処理と、Next.js プロキシ(`/api/twitch/games`)経由の取得を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import { fetchGameBoxArtUrl, parseGameBoxArtUrl } from "./game-box-art";

/** Helix Get Games API のレスポンス(検証に使う部分のみ) */
function createHelixGamesJson(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: [
      {
        id: "18122",
        name: "World of Warcraft",
        box_art_url: "https://static-cdn.jtvnw.net/ttv-boxart/18122-{width}x{height}.jpg",
        ...overrides,
      },
    ],
  };
}

describe("parseGameBoxArtUrl", () => {
  it("box_art_url の {width}x{height} プレースホルダを実サイズに解決した URL を返す", () => {
    expect(parseGameBoxArtUrl(createHelixGamesJson())).toBe(
      "https://static-cdn.jtvnw.net/ttv-boxart/18122-285x380.jpg",
    );
  });

  it("data が空(未知のゲームID)の場合は null を返す", () => {
    expect(parseGameBoxArtUrl({ data: [] })).toBeNull();
  });

  it("box_art_url が無い・型が違う・空文字の場合は null を返す", () => {
    expect(parseGameBoxArtUrl(createHelixGamesJson({ box_art_url: undefined }))).toBeNull();
    expect(parseGameBoxArtUrl(createHelixGamesJson({ box_art_url: 123 }))).toBeNull();
    expect(parseGameBoxArtUrl(createHelixGamesJson({ box_art_url: "" }))).toBeNull();
  });

  it("形式が想定と異なるレスポンス(data が配列でない等)は null を返す", () => {
    expect(parseGameBoxArtUrl(null)).toBeNull();
    expect(parseGameBoxArtUrl({})).toBeNull();
    expect(parseGameBoxArtUrl({ data: "not-an-array" })).toBeNull();
  });
});

describe("fetchGameBoxArtUrl", () => {
  it("Helix プロキシに id 付きで GET し、解決したボックスアート URL を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(createHelixGamesJson()));

    const url = await fetchGameBoxArtUrl("18122", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/games?id=18122", { signal: undefined });
    expect(url).toBe("https://static-cdn.jtvnw.net/ttv-boxart/18122-285x380.jpg");
  });

  it("ゲームID が空文字の場合はリクエストせず null を返す(カテゴリ未設定の配信)", async () => {
    const fetchFn = vi.fn();

    expect(await fetchGameBoxArtUrl("", fetchFn)).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("HTTP エラー(503: Helix 未設定など)の場合は null を返す(ボックスアートなしで動作を続けるため)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ error: "Helix API が設定されていません" }, { status: 503 }));

    expect(await fetchGameBoxArtUrl("18122", fetchFn)).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    expect(await fetchGameBoxArtUrl("18122", fetchFn)).toBeNull();
  });
});
