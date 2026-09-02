/**
 * src/store/cheermotes.ts(Cheermote 一覧のモジュールスコープ保持)のテスト。
 *
 * ROOMSTATE で判明した配信者の Twitch ID から Helix の Cheermotes API 経由で
 * Cheermote 一覧(グローバル + チャンネル独自)を読み込み、`chat-connection.ts` が
 * 発言受信時に同期的に参照できる一覧として保持する流れと、
 * Helix が利用できない場合の静的一覧へのフォールバックを検証する。
 * 実際の API 呼び出しは行わず、フェイクの読み込み関数を注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { STATIC_CHEERMOTE_SET, type CheermoteSet } from "@/lib/twitch/cheermotes";
import { buildEmoteImageUrl } from "@/lib/twitch/emotes";
import { clearCheermotes, getCheermoteSet, loadCheermotes, resetCheermotesForTests } from "./cheermotes";

afterEach(() => {
  resetCheermotesForTests();
});

/** テスト用の Cheermote 一覧(チャンネル独自 Cheermote を1件含む) */
const FAKE_CHEERMOTE_SET: CheermoteSet = new Map([
  [
    "cheer",
    [
      { minBits: 100, imageUrl: "https://example.com/cheer/100/2.gif" },
      { minBits: 1, imageUrl: "https://example.com/cheer/1/2.gif" },
    ],
  ],
  ["mycustom", [{ minBits: 1, imageUrl: "https://example.com/mycustom/1/2.gif" }]],
]);

describe("loadCheermotes", () => {
  it("未読み込みの間は静的一覧(STATIC_CHEERMOTE_SET)を返す", () => {
    expect(getCheermoteSet()).toBe(STATIC_CHEERMOTE_SET);
  });

  it("読み込んだ一覧を getCheermoteSet で参照できる", async () => {
    const fetchSet = vi.fn(async () => FAKE_CHEERMOTE_SET);

    await loadCheermotes("12345", fetchSet);

    expect(fetchSet).toHaveBeenCalledWith("12345");
    expect(getCheermoteSet()).toBe(FAKE_CHEERMOTE_SET);
  });

  it("読み込み成功後は buildEmoteImageUrl が API の画像 URL を返す(レジストリへの登録)", async () => {
    await loadCheermotes("12345", async () => FAKE_CHEERMOTE_SET);

    expect(buildEmoteImageUrl("cheer:mycustom/1")).toBe("https://example.com/mycustom/1/2.gif");
    expect(buildEmoteImageUrl("cheer:cheer/100")).toBe("https://example.com/cheer/100/2.gif");
  });

  it("同じ Twitch ID の2回目の読み込みは行わない(ROOMSTATE は再接続などで複数回届く)", async () => {
    const fetchSet = vi.fn(async () => FAKE_CHEERMOTE_SET);

    await loadCheermotes("12345", fetchSet);
    await loadCheermotes("12345", fetchSet);

    expect(fetchSet).toHaveBeenCalledTimes(1);
  });

  it("読み込みに失敗(null)した場合は静的一覧のまま、同じ ID で再試行できる", async () => {
    const fetchSet = vi.fn(async () => null);

    await loadCheermotes("12345", fetchSet);

    expect(getCheermoteSet()).toBe(STATIC_CHEERMOTE_SET);

    await loadCheermotes("12345", fetchSet);

    expect(fetchSet).toHaveBeenCalledTimes(2);
  });

  it("読み込み完了前に clearCheermotes された場合は結果を破棄する(チャンネル切り替え)", async () => {
    let resolveFetch: (set: CheermoteSet | null) => void = () => {};
    const fetchSet = vi.fn(
      () => new Promise<CheermoteSet | null>((resolve) => (resolveFetch = resolve)),
    );

    const loading = loadCheermotes("12345", fetchSet);
    clearCheermotes();
    resolveFetch(FAKE_CHEERMOTE_SET);
    await loading;

    expect(getCheermoteSet()).toBe(STATIC_CHEERMOTE_SET);
  });

  it("clearCheermotes すると静的一覧・静的 CDN URL に戻り、同じ ID でも再読み込みできる", async () => {
    const fetchSet = vi.fn(async () => FAKE_CHEERMOTE_SET);

    await loadCheermotes("12345", fetchSet);
    clearCheermotes();

    expect(getCheermoteSet()).toBe(STATIC_CHEERMOTE_SET);
    expect(buildEmoteImageUrl("cheer:cheer/100")).toBe(
      "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/2.gif",
    );

    await loadCheermotes("12345", fetchSet);

    expect(fetchSet).toHaveBeenCalledTimes(2);
    expect(getCheermoteSet()).toBe(FAKE_CHEERMOTE_SET);
  });
});
