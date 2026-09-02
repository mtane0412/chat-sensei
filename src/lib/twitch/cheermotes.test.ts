/**
 * src/lib/twitch/cheermotes.ts のテスト。
 *
 * bits 付き発言の本文に含まれる Cheering Emote(`Cheer100` / `showLove1000` など)を
 * 位置情報(EmotePosition)として既存の emote 処理に合成する純関数を検証する。
 */
import { describe, expect, it } from "vitest";
import { mergeCheermotePositions, resolveCheermoteTier } from "./cheermotes";
import type { EmotePosition } from "./irc-parser";

describe("resolveCheermoteTier", () => {
  it("bits 数に応じて表示ティア(1 / 100 / 1000 / 5000 / 10000)を返す", () => {
    expect(resolveCheermoteTier(1)).toBe(1);
    expect(resolveCheermoteTier(99)).toBe(1);
    expect(resolveCheermoteTier(100)).toBe(100);
    expect(resolveCheermoteTier(999)).toBe(100);
    expect(resolveCheermoteTier(1000)).toBe(1000);
    expect(resolveCheermoteTier(4999)).toBe(1000);
    expect(resolveCheermoteTier(5000)).toBe(5000);
    expect(resolveCheermoteTier(9999)).toBe(5000);
    expect(resolveCheermoteTier(10000)).toBe(10000);
    expect(resolveCheermoteTier(123456)).toBe(10000);
  });
});

describe("mergeCheermotePositions", () => {
  it("bits が null(Cheer していない発言)の場合は、公式 emote の位置情報をそのまま返す", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];
    expect(mergeCheermotePositions("Kappa Cheer100", twitchEmotes, null)).toEqual(twitchEmotes);
  });

  it("Cheer100 のプレフィックス部分だけを emote 位置として合成する(数値はテキストのまま残す)", () => {
    const result = mergeCheermotePositions("Cheer100 nice", [], 100);
    expect(result).toEqual([{ id: "cheer:cheer/100", start: 0, end: 4 }]);
  });

  it("showLove1000 は小文字化したプレフィックスと bits 数のティアで ID を組み立てる", () => {
    const result = mergeCheermotePositions("showLove1000", [], 1000);
    expect(result).toEqual([{ id: "cheer:showlove/1000", start: 0, end: 7 }]);
  });

  it("プレフィックスは大文字小文字を区別せずに照合する(Twitch の仕様)", () => {
    expect(mergeCheermotePositions("cheer100", [], 100)).toEqual([{ id: "cheer:cheer/100", start: 0, end: 4 }]);
    expect(mergeCheermotePositions("CHEER100", [], 100)).toEqual([{ id: "cheer:cheer/100", start: 0, end: 4 }]);
  });

  it("ティアは各トークンの bits 数から決める(発言全体の bits 合計ではない)", () => {
    const result = mergeCheermotePositions("Cheer1 Cheer5000", [], 5001);
    expect(result).toEqual([
      { id: "cheer:cheer/1", start: 0, end: 4 },
      { id: "cheer:cheer/5000", start: 7, end: 11 },
    ]);
  });

  it("既知のプレフィックスでない単語(hello100 など)は emote にしない", () => {
    expect(mergeCheermotePositions("hello100", [], 100)).toEqual([]);
  });

  it("数値が続かない単語(Cheer のみ)や 0 bits(Cheer0)は emote にしない", () => {
    expect(mergeCheermotePositions("Cheer", [], 100)).toEqual([]);
    expect(mergeCheermotePositions("Cheer0", [], 100)).toEqual([]);
  });

  it("単語の一部だけの一致(Cheer100! など)は emote にしない", () => {
    expect(mergeCheermotePositions("Cheer100!", [], 100)).toEqual([]);
  });

  it("公式 emote の範囲と重なる単語は公式 emote を優先して emote にしない", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "999", start: 0, end: 7 }];
    expect(mergeCheermotePositions("Cheer100", twitchEmotes, 100)).toEqual(twitchEmotes);
  });

  it("サロゲートペアの絵文字が前にあっても、コードポイント単位で位置を数える", () => {
    // "🌿 Cheer100" — 🌿 はコードポイント1つ(UTF-16では2ユニット)
    const result = mergeCheermotePositions("🌿 Cheer100", [], 100);
    expect(result).toEqual([{ id: "cheer:cheer/100", start: 2, end: 6 }]);
  });

  it("公式 emote と合成した結果は開始位置の昇順で返す", () => {
    const twitchEmotes: EmotePosition[] = [{ id: "25", start: 9, end: 13 }];
    const result = mergeCheermotePositions("Cheer100 Kappa", twitchEmotes, 100);
    expect(result).toEqual([
      { id: "cheer:cheer/100", start: 0, end: 4 },
      { id: "25", start: 9, end: 13 },
    ]);
  });
});
