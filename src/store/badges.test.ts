/**
 * src/store/badges.ts(チャットバッジ画像対応表の保持)のテスト。
 *
 * ROOMSTATE で判明した配信者の Twitch ID から Helix の Chat Badges API 経由で
 * 「set_id/version → 画像 URL」の対応表(グローバル + チャンネル固有)を読み込み、
 * 生IRC列の発言行が Zustand ストア経由で参照する流れと、
 * チャンネル切り替え時のクリア・失敗時の再試行(`src/store/cheermotes.ts` と同じ方針)を検証する。
 * 実際の API 呼び出しは行わず、フェイクの読み込み関数を注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearBadges, loadBadges, resetBadgesForTests, useBadgeStore } from "./badges";

afterEach(() => {
  resetBadgesForTests();
});

/** テスト用のバッジ画像対応表(モデレーターとチャンネル固有サブスクバッジ) */
const FAKE_BADGE_IMAGE_MAP = new Map([
  ["moderator/1", "https://cdn.example/moderator/1/2x.png"],
  ["subscriber/0", "https://cdn.example/channel/subscriber/0/2x.png"],
]);

describe("loadBadges", () => {
  it("未読み込みの間は空の対応表を返す", () => {
    expect(useBadgeStore.getState().badgeImages).toEqual({});
  });

  it("読み込んだ対応表をストアで参照できる", async () => {
    const fetchMap = vi.fn(async () => FAKE_BADGE_IMAGE_MAP);

    await loadBadges("12345", fetchMap);

    expect(fetchMap).toHaveBeenCalledWith("12345");
    expect(useBadgeStore.getState().badgeImages).toEqual({
      "moderator/1": "https://cdn.example/moderator/1/2x.png",
      "subscriber/0": "https://cdn.example/channel/subscriber/0/2x.png",
    });
  });

  it("同じ Twitch ID の2回目の読み込みは行わない(ROOMSTATE は再接続などで複数回届く)", async () => {
    const fetchMap = vi.fn(async () => FAKE_BADGE_IMAGE_MAP);

    await loadBadges("12345", fetchMap);
    await loadBadges("12345", fetchMap);

    expect(fetchMap).toHaveBeenCalledTimes(1);
  });

  it("読み込みに失敗(null = Helix 利用不可)した場合は空の対応表のまま、同じ ID で再試行できる", async () => {
    const fetchMap = vi.fn(async () => null);

    await loadBadges("12345", fetchMap);

    expect(useBadgeStore.getState().badgeImages).toEqual({});

    await loadBadges("12345", fetchMap);

    expect(fetchMap).toHaveBeenCalledTimes(2);
  });

  it("読み込み完了前に clearBadges された場合は結果を破棄する(チャンネル切り替え)", async () => {
    let resolveFetch: (map: Map<string, string> | null) => void = () => {};
    const fetchMap = vi.fn(
      () => new Promise<Map<string, string> | null>((resolve) => (resolveFetch = resolve)),
    );

    const loading = loadBadges("12345", fetchMap);
    clearBadges();
    resolveFetch(FAKE_BADGE_IMAGE_MAP);
    await loading;

    expect(useBadgeStore.getState().badgeImages).toEqual({});
  });

  it("別チャンネルの読み込みを新しく開始したら、遅れて届いた前チャンネルの結果で上書きしない", async () => {
    let resolveFirst: (map: Map<string, string> | null) => void = () => {};
    const firstFetch = vi.fn(
      () => new Promise<Map<string, string> | null>((resolve) => (resolveFirst = resolve)),
    );
    const secondMap = new Map([["vip/1", "https://cdn.example/vip/1/2x.png"]]);
    const secondFetch = vi.fn(async () => secondMap);

    const firstLoading = loadBadges("11111", firstFetch);
    clearBadges();
    await loadBadges("22222", secondFetch);
    resolveFirst(FAKE_BADGE_IMAGE_MAP);
    await firstLoading;

    expect(useBadgeStore.getState().badgeImages).toEqual({
      "vip/1": "https://cdn.example/vip/1/2x.png",
    });
  });
});

describe("clearBadges", () => {
  it("読み込み済みの対応表を破棄して未読み込み状態に戻す", async () => {
    await loadBadges("12345", async () => FAKE_BADGE_IMAGE_MAP);

    clearBadges();

    expect(useBadgeStore.getState().badgeImages).toEqual({});
  });
});
