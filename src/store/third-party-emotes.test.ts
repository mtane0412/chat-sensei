/**
 * src/store/third-party-emotes.ts(サードパーティ emote 対応表のモジュールスコープ保持)のテスト。
 *
 * ROOMSTATE で判明した配信者の Twitch ID から BTTV / FFZ / 7TV の emote を読み込み、
 * `chat-connection.ts` が発言受信時に同期的に参照できる対応表として保持する流れを検証する。
 * 実際の API 呼び出しは行わず、フェイクの読み込み関数を注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearThirdPartyEmotes,
  getThirdPartyEmoteMap,
  loadThirdPartyEmotes,
  resetThirdPartyEmotesForTests,
} from "./third-party-emotes";

afterEach(() => {
  resetThirdPartyEmotesForTests();
});

describe("loadThirdPartyEmotes", () => {
  it("読み込んだ対応表を getThirdPartyEmoteMap で参照できる", async () => {
    const fetchEmoteMap = vi.fn(async () => new Map([["catJAM", "bttv:g1"]]));

    await loadThirdPartyEmotes("12345", fetchEmoteMap);

    expect(fetchEmoteMap).toHaveBeenCalledWith("12345");
    expect(getThirdPartyEmoteMap().get("catJAM")).toBe("bttv:g1");
  });

  it("同じ Twitch ID の2回目の読み込みは行わない(ROOMSTATE は再接続などで複数回届く)", async () => {
    const fetchEmoteMap = vi.fn(async () => new Map([["catJAM", "bttv:g1"]]));

    await loadThirdPartyEmotes("12345", fetchEmoteMap);
    await loadThirdPartyEmotes("12345", fetchEmoteMap);

    expect(fetchEmoteMap).toHaveBeenCalledTimes(1);
  });

  it("読み込み完了前に clearThirdPartyEmotes された場合は結果を破棄する(チャンネル切り替え)", async () => {
    let resolveFetch: (map: Map<string, string>) => void = () => {};
    const fetchEmoteMap = vi.fn(
      () => new Promise<Map<string, string>>((resolve) => (resolveFetch = resolve)),
    );

    const loading = loadThirdPartyEmotes("12345", fetchEmoteMap);
    clearThirdPartyEmotes();
    resolveFetch(new Map([["catJAM", "bttv:g1"]]));
    await loading;

    expect(getThirdPartyEmoteMap().size).toBe(0);
  });

  it("clearThirdPartyEmotes すると対応表が空になり、同じ ID でも再読み込みできる", async () => {
    const fetchEmoteMap = vi.fn(async () => new Map([["catJAM", "bttv:g1"]]));

    await loadThirdPartyEmotes("12345", fetchEmoteMap);
    clearThirdPartyEmotes();

    expect(getThirdPartyEmoteMap().size).toBe(0);

    await loadThirdPartyEmotes("12345", fetchEmoteMap);

    expect(fetchEmoteMap).toHaveBeenCalledTimes(2);
    expect(getThirdPartyEmoteMap().get("catJAM")).toBe("bttv:g1");
  });
});
