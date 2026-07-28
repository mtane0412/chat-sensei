/**
 * src/lib/twitch/emotes.ts のテスト。
 *
 * `irc-parser.ts` が抽出した emote 位置情報(EmotePosition[])を、
 * 実際の画像表示に使えるCDN URLや、テキスト/emoteが交互に並ぶ
 * 描画用セグメントに変換する純関数を検証する。
 */
import { describe, expect, it } from "vitest";
import { buildEmoteImageUrl, splitMessageIntoSegments } from "./emotes";
import type { EmotePosition } from "./irc-parser";

describe("buildEmoteImageUrl", () => {
  it("emote IDからTwitchのCDN URL(ダークテーマ・2倍サイズ)を組み立てる", () => {
    expect(buildEmoteImageUrl("25")).toBe(
      "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
    );
  });

  it("themeとscaleを指定した場合はそれをURLに反映する", () => {
    expect(buildEmoteImageUrl("25", { theme: "light", scale: "1.0" })).toBe(
      "https://static-cdn.jtvnw.net/emoticons/v2/25/default/light/1.0",
    );
  });
});

describe("splitMessageIntoSegments", () => {
  it("emoteが無い場合はテキスト1件のセグメントを返す", () => {
    const segments = splitMessageIntoSegments("hello chat", []);

    expect(segments).toEqual([{ type: "text", text: "hello chat" }]);
  });

  it("文中の1箇所のemoteをテキストと画像セグメントに分割する", () => {
    // "nice Kappa play" の "Kappa"(6-10文字目, 0始まりinclusive) が emote id=25
    const emotes: EmotePosition[] = [{ id: "25", start: 5, end: 9 }];

    const segments = splitMessageIntoSegments("nice Kappa play", emotes);

    expect(segments).toEqual([
      { type: "text", text: "nice " },
      { type: "emote", id: "25", text: "Kappa" },
      { type: "text", text: " play" },
    ]);
  });

  it("同一emoteが複数回出現する場合もすべて画像セグメントに変換する", () => {
    // "Kappa test Kappa" : 1つ目 0-4, 2つ目 11-15
    const emotes: EmotePosition[] = [
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 11, end: 15 },
    ];

    const segments = splitMessageIntoSegments("Kappa test Kappa", emotes);

    expect(segments).toEqual([
      { type: "emote", id: "25", text: "Kappa" },
      { type: "text", text: " test " },
      { type: "emote", id: "25", text: "Kappa" },
    ]);
  });

  it("先頭からemoteの場合は前方に空テキストセグメントを作らない", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];

    const segments = splitMessageIntoSegments("Kappa", emotes);

    expect(segments).toEqual([{ type: "emote", id: "25", text: "Kappa" }]);
  });
});
