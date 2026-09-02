/**
 * src/lib/twitch/third-party-emotes.ts のテスト。
 *
 * BTTV / FFZ / 7TV の各 API レスポンスから「emote 名 → プレフィックス付き ID」の対応表を組み立てる処理と、
 * 発言本文の単語を対応表と照合してサードパーティ emote の位置情報(EmotePosition[])を合成する処理を検証する。
 * API 呼び出しはすべてフェイクの fetch を注入して行い、実際のネットワーク通信は行わない。
 */
import { describe, expect, it, vi } from "vitest";
import type { EmotePosition } from "./irc-parser";
import {
  buildThirdPartyEmoteMap,
  fetchThirdPartyEmoteMap,
  mergeThirdPartyEmotePositions,
  type ThirdPartyEmote,
} from "./third-party-emotes";

describe("buildThirdPartyEmoteMap", () => {
  it("emote 名をキー、プレフィックス付き ID を値とする対応表を作る", () => {
    const emotes: ThirdPartyEmote[] = [
      { code: "catJAM", id: "bttv:60ae958e229664e8667aea38" },
      { code: "AlienPls", id: "7tv:01F6MZGCNG000255K4X1K7NTHR" },
    ];

    const map = buildThirdPartyEmoteMap(emotes);

    expect(map.get("catJAM")).toBe("bttv:60ae958e229664e8667aea38");
    expect(map.get("AlienPls")).toBe("7tv:01F6MZGCNG000255K4X1K7NTHR");
  });

  it("同じ emote 名が複数ある場合は後勝ちにする(チャンネル emote がグローバル emote を上書きする)", () => {
    const emotes: ThirdPartyEmote[] = [
      { code: "catJAM", id: "bttv:global-id" },
      { code: "catJAM", id: "7tv:channel-id" },
    ];

    const map = buildThirdPartyEmoteMap(emotes);

    expect(map.get("catJAM")).toBe("7tv:channel-id");
  });
});

describe("mergeThirdPartyEmotePositions", () => {
  const emoteMap = new Map([
    ["catJAM", "bttv:60ae958e229664e8667aea38"],
    ["AlienPls", "7tv:01F6MZGCNG000255K4X1K7NTHR"],
  ]);

  it("本文中の emote 名に一致する単語を EmotePosition として合成する", () => {
    const result = mergeThirdPartyEmotePositions("catJAM nice", [], emoteMap);

    expect(result).toEqual([{ id: "bttv:60ae958e229664e8667aea38", start: 0, end: 5 }]);
  });

  it("Twitch 公式 emote の位置情報と結合し、開始位置の昇順で返す", () => {
    // "Kappa catJAM" — Kappa(id:25)は Twitch の emotes タグ由来
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];

    const result = mergeThirdPartyEmotePositions("Kappa catJAM", twitchEmotes, emoteMap);

    expect(result).toEqual([
      { id: "25", start: 0, end: 4 },
      { id: "bttv:60ae958e229664e8667aea38", start: 6, end: 11 },
    ]);
  });

  it("単語の一部として含まれるだけの emote 名(部分一致)は emote にしない", () => {
    const result = mergeThirdPartyEmotePositions("catJAMmer says catJAM!", [], emoteMap);

    // "catJAMmer" も "catJAM!" も空白区切りの単語全体が emote 名と一致しないため対象外
    expect(result).toEqual([]);
  });

  it("emote 名の大文字小文字は区別する", () => {
    const result = mergeThirdPartyEmotePositions("catjam", [], emoteMap);

    expect(result).toEqual([]);
  });

  it("サロゲートペアの絵文字が前にあってもコードポイント単位の位置を返す(Twitch の emotes タグと同じ基準)", () => {
    // 🌿 は UTF-16 では2コードユニットだが、位置はコードポイント単位で数える
    const result = mergeThirdPartyEmotePositions("🌿 catJAM", [], emoteMap);

    expect(result).toEqual([{ id: "bttv:60ae958e229664e8667aea38", start: 2, end: 7 }]);
  });

  it("同じ emote 名が複数回現れたら出現ごとに位置を返す", () => {
    const result = mergeThirdPartyEmotePositions("catJAM catJAM", [], emoteMap);

    expect(result).toEqual([
      { id: "bttv:60ae958e229664e8667aea38", start: 0, end: 5 },
      { id: "bttv:60ae958e229664e8667aea38", start: 7, end: 12 },
    ]);
  });

  it("対応表が空なら Twitch 公式 emote の位置情報をそのまま返す", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];

    const result = mergeThirdPartyEmotePositions("Kappa", twitchEmotes, new Map());

    expect(result).toEqual(twitchEmotes);
  });
});

/** フェイク fetch: URL の部分一致で JSON レスポンスを返す。未定義の URL は 404 を返す */
function createFakeFetch(responses: Record<string, unknown>): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(body), { status: 200 });
      }
    }
    return new Response("Not Found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("fetchThirdPartyEmoteMap", () => {
  const bttvGlobal = [{ id: "bttv-g1", code: "catJAM", imageType: "webp", animated: true }];
  const bttvUser = {
    channelEmotes: [{ id: "bttv-c1", code: "chDance", imageType: "webp", animated: true }],
    sharedEmotes: [{ id: "bttv-s1", code: "chShared", imageType: "webp", animated: false }],
  };
  const ffzGlobal = [{ id: 111, code: "ffzGlobalEmote", images: { "1x": "u1", "2x": "u2", "4x": null } }];
  const ffzChannel = [{ id: 222, code: "ffzChannelEmote", images: { "1x": "u1", "2x": null, "4x": null } }];
  const sevenTvGlobal = { emotes: [{ id: "7tv-g1", name: "AlienPls" }] };
  const sevenTvUser = { emote_set: { emotes: [{ id: "7tv-c1", name: "chAlien" }] } };

  it("BTTV / FFZ / 7TV のグローバル・チャンネル emote をすべて集めた対応表を返す", async () => {
    const fetchFn = createFakeFetch({
      "api.betterttv.net/3/cached/emotes/global": bttvGlobal,
      "api.betterttv.net/3/cached/users/twitch/12345": bttvUser,
      "api.betterttv.net/3/cached/frankerfacez/emotes/global": ffzGlobal,
      "api.betterttv.net/3/cached/frankerfacez/users/twitch/12345": ffzChannel,
      "7tv.io/v3/emote-sets/global": sevenTvGlobal,
      "7tv.io/v3/users/twitch/12345": sevenTvUser,
    });

    const map = await fetchThirdPartyEmoteMap("12345", fetchFn);

    expect(map.get("catJAM")).toBe("bttv:bttv-g1");
    expect(map.get("chDance")).toBe("bttv:bttv-c1");
    expect(map.get("chShared")).toBe("bttv:bttv-s1");
    expect(map.get("ffzGlobalEmote")).toBe("ffz:111");
    expect(map.get("ffzChannelEmote")).toBe("ffz:222");
    expect(map.get("AlienPls")).toBe("7tv:7tv-g1");
    expect(map.get("chAlien")).toBe("7tv:7tv-c1");
  });

  it("チャンネル emote は同名のグローバル emote を上書きする", async () => {
    const fetchFn = createFakeFetch({
      "api.betterttv.net/3/cached/emotes/global": [{ id: "bttv-g1", code: "sameName" }],
      "7tv.io/v3/users/twitch/12345": { emote_set: { emotes: [{ id: "7tv-c1", name: "sameName" }] } },
    });

    const map = await fetchThirdPartyEmoteMap("12345", fetchFn);

    expect(map.get("sameName")).toBe("7tv:7tv-c1");
  });

  it("未登録チャンネル(404)や一部プロバイダの障害があっても、他のプロバイダの emote は返す", async () => {
    // BTTV グローバルだけ成功し、他はすべて 404(未登録チャンネル相当)
    const fetchFn = createFakeFetch({
      "api.betterttv.net/3/cached/emotes/global": bttvGlobal,
    });

    const map = await fetchThirdPartyEmoteMap("12345", fetchFn);

    expect(map.get("catJAM")).toBe("bttv:bttv-g1");
    expect(map.size).toBe(1);
  });

  it("fetch 自体が例外を投げるプロバイダがあっても、他のプロバイダの emote は返す", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.betterttv.net/3/cached/emotes/global")) {
        return new Response(JSON.stringify(bttvGlobal), { status: 200 });
      }
      throw new TypeError("network error");
    }) as unknown as typeof fetch;

    const map = await fetchThirdPartyEmoteMap("12345", fetchFn);

    expect(map.get("catJAM")).toBe("bttv:bttv-g1");
    expect(map.size).toBe(1);
  });
});
