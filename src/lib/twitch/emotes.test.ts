/**
 * src/lib/twitch/emotes.ts のテスト。
 *
 * `irc-parser.ts` が抽出した emote 位置情報(EmotePosition[])を、
 * 実際の画像表示に使えるCDN URLや、テキスト/emoteが交互に並ぶ
 * 描画用セグメントに変換する純関数を検証する。
 */
import { describe, expect, it } from "vitest";
import {
  buildEmoteImageUrl,
  isEmoteOnlyMessage,
  maskEmotesWithPlaceholders,
  restoreEmotesFromPlaceholders,
  splitMessageIntoSegments,
} from "./emotes";
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

  it("サロゲートペアの絵文字が前にあっても、コードポイント単位の位置から emote を正しく切り出す", () => {
    // Twitch の emotes タグはコードポイント単位。"🌿 haddyHiya" は 🌿(1コードポイント・UTF-16では2単位)の後、
    // 空白を挟んで 2-10 コードポイント目が emote
    const emotes: EmotePosition[] = [{ id: "emotesv2_1", start: 2, end: 10 }];

    const segments = splitMessageIntoSegments("🌿 haddyHiya", emotes);

    expect(segments).toEqual([
      { type: "text", text: "🌿 " },
      { type: "emote", id: "emotesv2_1", text: "haddyHiya" },
    ]);
  });

  it("絵文字が複数ある場合も、絵文字の数だけずれずに emote を切り出す", () => {
    // "💻hugs💻 haddyHiya": 💻(0) h(1) u g s(4) 💻(5) 空白(6) haddyHiya(7-15)
    const emotes: EmotePosition[] = [{ id: "emotesv2_1", start: 7, end: 15 }];

    const segments = splitMessageIntoSegments("💻hugs💻 haddyHiya", emotes);

    expect(segments).toEqual([
      { type: "text", text: "💻hugs💻 " },
      { type: "emote", id: "emotesv2_1", text: "haddyHiya" },
    ]);
  });
});

describe("maskEmotesWithPlaceholders", () => {
  it("emote が無い場合は本文をそのまま返し、置換表は空になる", () => {
    expect(maskEmotesWithPlaceholders("hello chat", [])).toEqual({ maskedText: "hello chat", placeholders: [] });
  });

  it("emote を出現順に [[E0]], [[E1]] のプレースホルダへ置き換え、トークンと emote の対応を返す(issue #44)", () => {
    const emotes: EmotePosition[] = [
      { id: "emotesv2_wave", start: 16, end: 24 },
      { id: "25", start: 26, end: 30 },
    ];

    expect(maskEmotesWithPlaceholders("@vaniks890 Ello peepoWave Kappa", emotes)).toEqual({
      maskedText: "@vaniks890 Ello [[E0]] [[E1]]",
      placeholders: [
        { token: "[[E0]]", id: "emotesv2_wave", text: "peepoWave" },
        { token: "[[E1]]", id: "25", text: "Kappa" },
      ],
    });
  });

  it("同じ emote が複数回現れても出現ごとに別のプレースホルダを割り当てる", () => {
    const emotes: EmotePosition[] = [
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 8, end: 12 },
    ];

    expect(maskEmotesWithPlaceholders("Kappa 草 Kappa", emotes).maskedText).toBe("[[E0]] 草 [[E1]]");
  });
});

describe("restoreEmotesFromPlaceholders", () => {
  const 置換表 = [
    { token: "[[E0]]", id: "emotesv2_wave", text: "peepoWave" },
    { token: "[[E1]]", id: "25", text: "Kappa" },
  ];

  it("置換表が空の場合は訳文をテキスト1件のセグメントとして返す", () => {
    expect(restoreEmotesFromPlaceholders("マジで?", [])).toEqual([{ type: "text", text: "マジで?" }]);
  });

  it("訳文中のプレースホルダを emote セグメントに戻し、前後のテキストはそのまま残す(issue #44)", () => {
    const segments = restoreEmotesFromPlaceholders("@vaniks890 やあ [[E0]] [[E1]]", 置換表);

    expect(segments).toEqual([
      { type: "text", text: "@vaniks890 やあ " },
      { type: "emote", id: "emotesv2_wave", text: "peepoWave" },
      { type: "text", text: " " },
      { type: "emote", id: "25", text: "Kappa" },
    ]);
  });

  it("プレースホルダが日本語に隣接していても emote セグメントに戻す", () => {
    const segments = restoreEmotesFromPlaceholders("なんで[[E1]]そんな", [置換表[1]]);

    expect(segments).toEqual([
      { type: "text", text: "なんで" },
      { type: "emote", id: "25", text: "Kappa" },
      { type: "text", text: "そんな" },
    ]);
  });

  it("LLM が訳文からプレースホルダを落とした場合は、emote 画像が失われないよう末尾に補う", () => {
    const segments = restoreEmotesFromPlaceholders("@vaniks890 やあ [[E1]]", 置換表);

    expect(segments).toEqual([
      { type: "text", text: "@vaniks890 やあ " },
      { type: "emote", id: "25", text: "Kappa" },
      { type: "text", text: " " },
      { type: "emote", id: "emotesv2_wave", text: "peepoWave" },
    ]);
  });

  it("置換表に無い [[E数字]] 形式のトークン(モデルの創作)は訳文から取り除く", () => {
    const segments = restoreEmotesFromPlaceholders("やあ [[E9]] [[E0]]", [置換表[0]]);

    expect(segments).toEqual([
      { type: "text", text: "やあ " },
      { type: "emote", id: "emotesv2_wave", text: "peepoWave" },
    ]);
  });

  it("置換表が空でも、モデルが書き出した [[E数字]] 形式のトークンは直前の空白ごと取り除く", () => {
    expect(restoreEmotesFromPlaceholders("拍手喝采！[[E0]]", [])).toEqual([{ type: "text", text: "拍手喝采！" }]);
    expect(restoreEmotesFromPlaceholders("拍手喝采 [[E0]]", [])).toEqual([{ type: "text", text: "拍手喝采" }]);
  });

  it("モデルが括弧を増やして書き出した [[[E0]]] のような崩れたトークンも取り除く", () => {
    expect(restoreEmotesFromPlaceholders("疑わしいかった [[[E0]]]", [])).toEqual([
      { type: "text", text: "疑わしいかった" },
    ]);
  });
});

describe("isEmoteOnlyMessage", () => {
  it("emote だけ(空白区切りの繰り返しを含む)の発言は true", () => {
    const emotes: EmotePosition[] = [
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 6, end: 10 },
    ];

    expect(isEmoteOnlyMessage("Kappa Kappa", emotes)).toBe(true);
  });

  it("emote 以外の文字がある発言は false", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 5, end: 9 }];

    expect(isEmoteOnlyMessage("nice Kappa", emotes)).toBe(false);
  });

  it("emote が無い発言は false(空文字列でも翻訳側の判断に委ねる)", () => {
    expect(isEmoteOnlyMessage("hello", [])).toBe(false);
    expect(isEmoteOnlyMessage("", [])).toBe(false);
  });
});
