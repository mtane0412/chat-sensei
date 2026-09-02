/**
 * src/lib/twitch/cheermotes.ts のテスト。
 *
 * Helix の Cheermotes API から取得した一覧(CheermoteSet)をもとに、bits 付き発言の
 * 本文に含まれる Cheering Emote(`Cheer100` / `showLove1000` など)を位置情報
 * (EmotePosition)として既存の emote 処理に合成する流れと、
 * API レスポンスの解析・フォールバック用静的一覧を検証する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  STATIC_CHEERMOTE_SET,
  buildCheermoteImageUrlMap,
  fetchCheermoteSet,
  mergeCheermotePositions,
  parseCheermoteSet,
  resolveCheermoteTier,
  type CheermoteTier,
} from "./cheermotes";
import type { EmotePosition } from "./irc-parser";

/** テスト用のティア一覧(minBits の降順)。実際の Cheer と同じ 5 段階 */
const SAMPLE_TIERS: readonly CheermoteTier[] = [
  { minBits: 10000, imageUrl: "https://example.com/cheer/10000.gif" },
  { minBits: 5000, imageUrl: "https://example.com/cheer/5000.gif" },
  { minBits: 1000, imageUrl: "https://example.com/cheer/1000.gif" },
  { minBits: 100, imageUrl: "https://example.com/cheer/100.gif" },
  { minBits: 1, imageUrl: "https://example.com/cheer/1.gif" },
];

describe("resolveCheermoteTier", () => {
  it("bits 数以下で最大の minBits を持つティアを返す", () => {
    expect(resolveCheermoteTier(1, SAMPLE_TIERS)?.minBits).toBe(1);
    expect(resolveCheermoteTier(99, SAMPLE_TIERS)?.minBits).toBe(1);
    expect(resolveCheermoteTier(100, SAMPLE_TIERS)?.minBits).toBe(100);
    expect(resolveCheermoteTier(999, SAMPLE_TIERS)?.minBits).toBe(100);
    expect(resolveCheermoteTier(1000, SAMPLE_TIERS)?.minBits).toBe(1000);
    expect(resolveCheermoteTier(4999, SAMPLE_TIERS)?.minBits).toBe(1000);
    expect(resolveCheermoteTier(5000, SAMPLE_TIERS)?.minBits).toBe(5000);
    expect(resolveCheermoteTier(9999, SAMPLE_TIERS)?.minBits).toBe(5000);
    expect(resolveCheermoteTier(10000, SAMPLE_TIERS)?.minBits).toBe(10000);
    expect(resolveCheermoteTier(123456, SAMPLE_TIERS)?.minBits).toBe(10000);
  });

  it("最小ティアに満たない bits 数(チャンネル独自の最低 100 bits など)では null を返す", () => {
    const tiers: readonly CheermoteTier[] = [
      { minBits: 1000, imageUrl: "https://example.com/custom/1000.gif" },
      { minBits: 100, imageUrl: "https://example.com/custom/100.gif" },
    ];
    expect(resolveCheermoteTier(99, tiers)).toBeNull();
  });
});

describe("STATIC_CHEERMOTE_SET(Helix 利用不可時のフォールバック)", () => {
  it("グローバル Cheermote のプレフィックスを 5 ティア構成で持つ", () => {
    const tiers = STATIC_CHEERMOTE_SET.get("cheer");
    expect(tiers?.map((tier) => tier.minBits)).toEqual([10000, 5000, 1000, 100, 1]);
    expect(STATIC_CHEERMOTE_SET.has("showlove")).toBe(true);
    expect(STATIC_CHEERMOTE_SET.has("kappa")).toBe(true);
  });

  it("画像 URL は静的 CDN(ダーク・アニメ・2倍)の URL を持つ", () => {
    const tiers = STATIC_CHEERMOTE_SET.get("cheer");
    expect(tiers?.find((tier) => tier.minBits === 100)?.imageUrl).toBe(
      "https://d3aqoihi2n8ty8.cloudfront.net/actions/cheer/dark/animated/100/2.gif",
    );
  });
});

describe("mergeCheermotePositions", () => {
  it("bits が null(Cheer していない発言)の場合は、公式 emote の位置情報をそのまま返す", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];
    expect(mergeCheermotePositions("Kappa Cheer100", twitchEmotes, null, STATIC_CHEERMOTE_SET)).toEqual(twitchEmotes);
  });

  it("Cheer100 のプレフィックス部分だけを emote 位置として合成する(数値はテキストのまま残す)", () => {
    const result = mergeCheermotePositions("Cheer100 nice", [], 100, STATIC_CHEERMOTE_SET);
    expect(result).toEqual([{ id: "cheer:cheer/100", start: 0, end: 4 }]);
  });

  it("showLove1000 は小文字化したプレフィックスと bits 数のティアで ID を組み立てる", () => {
    const result = mergeCheermotePositions("showLove1000", [], 1000, STATIC_CHEERMOTE_SET);
    expect(result).toEqual([{ id: "cheer:showlove/1000", start: 0, end: 7 }]);
  });

  it("プレフィックスは大文字小文字を区別せずに照合する(Twitch の仕様)", () => {
    expect(mergeCheermotePositions("cheer100", [], 100, STATIC_CHEERMOTE_SET)).toEqual([
      { id: "cheer:cheer/100", start: 0, end: 4 },
    ]);
    expect(mergeCheermotePositions("CHEER100", [], 100, STATIC_CHEERMOTE_SET)).toEqual([
      { id: "cheer:cheer/100", start: 0, end: 4 },
    ]);
  });

  it("ティアは各トークンの bits 数から決める(発言全体の bits 合計ではない)", () => {
    const result = mergeCheermotePositions("Cheer1 Cheer5000", [], 5001, STATIC_CHEERMOTE_SET);
    expect(result).toEqual([
      { id: "cheer:cheer/1", start: 0, end: 4 },
      { id: "cheer:cheer/5000", start: 7, end: 11 },
    ]);
  });

  it("一覧に無いプレフィックスの単語(hello100 など)は emote にしない", () => {
    expect(mergeCheermotePositions("hello100", [], 100, STATIC_CHEERMOTE_SET)).toEqual([]);
  });

  it("チャンネル独自 Cheermote のプレフィックスを含む一覧なら、その単語も emote にする", () => {
    const customSet = new Map([
      ...STATIC_CHEERMOTE_SET,
      ["mycustom", SAMPLE_TIERS],
    ]);
    expect(mergeCheermotePositions("myCustom100", [], 100, customSet)).toEqual([
      { id: "cheer:mycustom/100", start: 0, end: 7 },
    ]);
  });

  it("最小ティアに満たない bits 数のトークンは emote にしない", () => {
    const customSet = new Map([
      ["mycustom", [{ minBits: 100, imageUrl: "https://example.com/custom/100.gif" }]],
    ]);
    expect(mergeCheermotePositions("myCustom50", [], 50, customSet)).toEqual([]);
  });

  it("数値が続かない単語(Cheer のみ)や 0 bits(Cheer0)は emote にしない", () => {
    expect(mergeCheermotePositions("Cheer", [], 100, STATIC_CHEERMOTE_SET)).toEqual([]);
    expect(mergeCheermotePositions("Cheer0", [], 100, STATIC_CHEERMOTE_SET)).toEqual([]);
  });

  it("単語の一部だけの一致(Cheer100! など)は emote にしない", () => {
    expect(mergeCheermotePositions("Cheer100!", [], 100, STATIC_CHEERMOTE_SET)).toEqual([]);
  });

  it("公式 emote の範囲と重なる単語は公式 emote を優先して emote にしない", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "999", start: 0, end: 7 }];
    expect(mergeCheermotePositions("Cheer100", twitchEmotes, 100, STATIC_CHEERMOTE_SET)).toEqual(twitchEmotes);
  });

  it("サロゲートペアの絵文字が前にあっても、コードポイント単位で位置を数える", () => {
    // "🌿 Cheer100" — 🌿 はコードポイント1つ(UTF-16では2ユニット)
    const result = mergeCheermotePositions("🌿 Cheer100", [], 100, STATIC_CHEERMOTE_SET);
    expect(result).toEqual([{ id: "cheer:cheer/100", start: 2, end: 6 }]);
  });

  it("公式 emote と合成した結果は開始位置の昇順で返す", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 9, end: 13 }];
    const result = mergeCheermotePositions("Cheer100 Kappa", twitchEmotes, 100, STATIC_CHEERMOTE_SET);
    expect(result).toEqual([
      { id: "cheer:cheer/100", start: 0, end: 4 },
      { id: "25", start: 9, end: 13 },
    ]);
  });
});

/** Helix の Cheermotes API レスポンス(必要な項目のみ)のサンプルを作る */
function createHelixCheermotesJson(): unknown {
  return {
    data: [
      {
        prefix: "Cheer",
        tiers: [
          {
            min_bits: 1,
            id: "1",
            images: { dark: { animated: { "1": "https://example.com/cheer/1/1.gif", "2": "https://example.com/cheer/1/2.gif" } } },
          },
          {
            min_bits: 100,
            id: "100",
            images: { dark: { animated: { "1": "https://example.com/cheer/100/1.gif", "2": "https://example.com/cheer/100/2.gif" } } },
          },
        ],
        type: "global_first_party",
      },
      {
        prefix: "myCustom",
        tiers: [
          {
            min_bits: 100,
            id: "100",
            images: { dark: { animated: { "2": "https://example.com/mycustom/100/2.gif" } } },
          },
        ],
        type: "channel_custom",
      },
    ],
  };
}

describe("parseCheermoteSet", () => {
  it("プレフィックスを小文字化し、ティアを minBits の降順に並べた CheermoteSet を返す", () => {
    const set = parseCheermoteSet(createHelixCheermotesJson());

    expect(set.get("cheer")).toEqual([
      { minBits: 100, imageUrl: "https://example.com/cheer/100/2.gif" },
      { minBits: 1, imageUrl: "https://example.com/cheer/1/2.gif" },
    ]);
    expect(set.get("mycustom")).toEqual([
      { minBits: 100, imageUrl: "https://example.com/mycustom/100/2.gif" },
    ]);
  });

  it("形式が想定と異なる項目(prefix 欠落・2倍画像なしのティアなど)は読み飛ばす", () => {
    const set = parseCheermoteSet({
      data: [
        { tiers: [] },
        {
          prefix: "Broken",
          tiers: [{ min_bits: 1, images: { dark: { animated: {} } } }],
        },
        {
          prefix: "Ok",
          tiers: [
            { min_bits: 1, images: { dark: { animated: { "2": "https://example.com/ok/1/2.gif" } } } },
            "invalid-tier",
          ],
        },
      ],
    });

    expect([...set.keys()]).toEqual(["ok"]);
    expect(set.get("ok")).toEqual([{ minBits: 1, imageUrl: "https://example.com/ok/1/2.gif" }]);
  });

  it("配列でない・data が無いレスポンスは空の CheermoteSet を返す", () => {
    expect(parseCheermoteSet(null).size).toBe(0);
    expect(parseCheermoteSet({}).size).toBe(0);
    expect(parseCheermoteSet({ data: "oops" }).size).toBe(0);
  });
});

describe("buildCheermoteImageUrlMap", () => {
  it("emote ID(cheer: 以降の `プレフィックス/ティア`)から画像 URL への対応表を作る", () => {
    const set = parseCheermoteSet(createHelixCheermotesJson());
    const urlMap = buildCheermoteImageUrlMap(set);

    expect(urlMap.get("cheer/100")).toBe("https://example.com/cheer/100/2.gif");
    expect(urlMap.get("cheer/1")).toBe("https://example.com/cheer/1/2.gif");
    expect(urlMap.get("mycustom/100")).toBe("https://example.com/mycustom/100/2.gif");
  });
});

describe("fetchCheermoteSet", () => {
  it("Helix プロキシに broadcaster_id 付きで GET し、解析した CheermoteSet を返す", async () => {
    const fetchFn = vi.fn(async () => Response.json(createHelixCheermotesJson()));

    const set = await fetchCheermoteSet("552120296", fetchFn);

    expect(fetchFn).toHaveBeenCalledWith("/api/twitch/bits/cheermotes?broadcaster_id=552120296", {
      signal: undefined,
    });
    expect(set?.get("mycustom")).toEqual([
      { minBits: 100, imageUrl: "https://example.com/mycustom/100/2.gif" },
    ]);
  });

  it("HTTP エラー(503: Helix 未設定など)の場合は null を返す(静的一覧へのフォールバック用)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ error: "Helix API が設定されていません" }, { status: 503 }));

    expect(await fetchCheermoteSet("552120296", fetchFn)).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error("network down");
    });

    expect(await fetchCheermoteSet("552120296", fetchFn)).toBeNull();
  });

  it("Cheermote が 1 件も無いレスポンスは null を返す(グローバル Cheermote は常に存在するはずのため)", async () => {
    const fetchFn = vi.fn(async () => Response.json({ data: [] }));

    expect(await fetchCheermoteSet("552120296", fetchFn)).toBeNull();
  });
});
