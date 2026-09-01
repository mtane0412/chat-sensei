/**
 * src/lib/ai/pickup-filter.ts のテスト。
 *
 * Pick up の前後に置く決定的(LLM を使わない)処理を検証する(issue #26)。
 * - `preparePickupInput`: emote・@メンション・URL を本文から除き、LLM に渡す本文を組み立てる
 * - `filterPickupTerms`: LLM が返した語句のうち emote 名・@メンション・文字を含まない語句・笑い声(issue #30)・
 *   相槌・感嘆詞(issue #33)を落とす
 */
import { describe, expect, it } from "vitest";
import { filterPickupTerms, preparePickupInput } from "./pickup-filter";
import type { EmotePosition } from "@/lib/twitch/irc-parser";

describe("preparePickupInput", () => {
  it("emote が無く特殊なトークンも無い本文はそのまま返す", () => {
    const prepared = preparePickupInput("bro is cooked lmao", []);

    expect(prepared).toEqual({ text: "bro is cooked lmao", emoteNames: [], mentionNames: [] });
  });

  it("emotes タグの位置にある emote 名を本文から除き、除いた emote 名を保持する", () => {
    // "xqcPeepo DID THAT NOT STICKY HIM" の xqcPeepo(0-7文字目)が emote
    const emotes: EmotePosition[] = [{ id: "emotesv2_1", start: 0, end: 7 }];

    const prepared = preparePickupInput("xqcPeepo DID THAT NOT STICKY HIM", emotes);

    expect(prepared.text).toBe("DID THAT NOT STICKY HIM");
    expect(prepared.emoteNames).toEqual(["xqcPeepo"]);
  });

  it("同じ emote が複数回登場しても emote 名は重複なく保持する", () => {
    const emotes: EmotePosition[] = [
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 10, end: 14 },
    ];

    const prepared = preparePickupInput("Kappa lol Kappa", emotes);

    expect(prepared.text).toBe("lol");
    expect(prepared.emoteNames).toEqual(["Kappa"]);
  });

  it("emote だけの発言は本文が空文字列になる", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 0, end: 4 }];

    const prepared = preparePickupInput("Kappa", emotes);

    expect(prepared.text).toBe("");
    expect(prepared.emoteNames).toEqual(["Kappa"]);
  });

  it("@メンションを本文から除き、@ を外したユーザー名を保持する", () => {
    const prepared = preparePickupInput("@AUBREY that was a W", []);

    expect(prepared.text).toBe("that was a W");
    expect(prepared.mentionNames).toEqual(["AUBREY"]);
  });

  it("URL を本文から除く", () => {
    const prepared = preparePickupInput("check this https://example.com/clip lol", []);

    expect(prepared.text).toBe("check this lol");
  });

  it("除去によって生じた連続する空白は1つにまとめ、前後の空白を落とす", () => {
    const emotes: EmotePosition[] = [{ id: "25", start: 4, end: 8 }];

    const prepared = preparePickupInput("gg  Kappa  chat ", emotes);

    expect(prepared.text).toBe("gg chat");
  });
});

describe("filterPickupTerms", () => {
  const 前処理済み = { text: "DID THAT NOT STICKY HIM", emoteNames: ["xqcPeepo"], mentionNames: ["AUBREY"] };

  it("emote 名と一致する語句を落とす(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "xqcpeepo", meaning: "特定の配信者関連の絵文字" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("@ で始まる語句と、@メンションのユーザー名と一致する語句を落とす", () => {
    const terms = [
      { term: "@AUBREY", meaning: "特定の視聴者への呼称" },
      { term: "aubrey", meaning: "特定の視聴者への呼称" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("文字を1つも含まない語句(数字や記号だけ)を落とす", () => {
    const terms = [
      { term: "67", meaning: "日付や時間を示す可能性" },
      { term: "10:30", meaning: "時刻" },
      { term: "???", meaning: "困惑" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("! で始まる語句(チャットコマンド)を落とす", () => {
    const terms = [
      { term: "!chimkin", meaning: "鶏肉のミーム" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual([{ term: "sticky", meaning: "スタン状態にする" }]);
  });

  it("追加で指定した除外名(表示中の発言者名など)と一致する語句を落とす(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "space_toilet_master", meaning: "配信の常連" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, 前処理済み, ["Space_Toilet_Master"])).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("同じ語句が複数回返ってきた場合は最初の1件だけ残す(大文字小文字は区別しない)", () => {
    const terms = [
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
      { term: "sayuwukuru", meaning: "繰り返される" },
      { term: "sticky", meaning: "スタン状態にする" },
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
    ];

    expect(filterPickupTerms(terms, { text: "sayuwuKuru sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sayuwuKuru", meaning: "意味不明な文字列" },
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("笑い声(haha / hahaha / hehe / HAHA)を落とし、略語の lol / lmao は残す(issue #30)", () => {
    const terms = [
      { term: "haha", meaning: "笑い声" },
      { term: "hahaha", meaning: "笑い声" },
      { term: "hehe", meaning: "軽い笑い" },
      { term: "HAHA", meaning: "笑い声" },
      { term: "hah", meaning: "笑い声" },
      { term: "lol", meaning: "爆笑" },
      { term: "lmao", meaning: "大爆笑" },
      { term: "put effort into", meaning: "〜に力を注ぐ" },
    ];

    expect(
      filterPickupTerms(terms, { text: "they put so much effort into it haha lol lmao", emoteNames: [], mentionNames: [] }),
    ).toEqual([
      { term: "lol", meaning: "爆笑" },
      { term: "lmao", meaning: "大爆笑" },
      { term: "put effort into", meaning: "〜に力を注ぐ" },
    ]);
  });

  it("前後に記号が付いた笑い声(haha! / (hehe) / hahaha...)も落とす", () => {
    const terms = [
      { term: "haha!", meaning: "笑い声" },
      { term: "(hehe)", meaning: "軽い笑い" },
      { term: "hahaha...", meaning: "笑い声" },
      { term: "lol!", meaning: "爆笑" },
    ];

    expect(filterPickupTerms(terms, { text: "haha! (hehe) hahaha... lol!", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "lol!", meaning: "爆笑" },
    ]);
  });

  it("普遍的な相槌・感嘆詞(oh / wow / hmm / ah / eh / uh / om)を落とし、略語やミーム(lol / pog)は残す(issue #33)", () => {
    const terms = [
      { term: "oh", meaning: "驚きを表す感嘆詞" },
      { term: "Wow", meaning: "驚きを表す感嘆詞" },
      { term: "hmm", meaning: "考え込むときの相槌" },
      { term: "ah", meaning: "納得したときの感嘆詞" },
      { term: "eh", meaning: "疑問を表す間投詞" },
      { term: "uh", meaning: "言いよどみ" },
      { term: "om", meaning: "驚きや興奮を表す感嘆詞" },
      { term: "lol", meaning: "爆笑" },
      { term: "pog", meaning: "すごい" },
    ];

    expect(filterPickupTerms(terms, { text: "oh Wow hmm ah eh uh om lol pog", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "lol", meaning: "爆笑" },
      { term: "pog", meaning: "すごい" },
    ]);
  });

  it("文字を伸ばした相槌・感嘆詞(ohhh / hmmm / wowww)、綴り揺れ(woah / eww)、前後に記号が付いた形(oh! / wow...)も落とす(issue #33)", () => {
    const terms = [
      { term: "ohhh", meaning: "驚きを表す感嘆詞" },
      { term: "hmmm", meaning: "考え込むときの相槌" },
      { term: "wowww", meaning: "驚きを表す感嘆詞" },
      { term: "woah", meaning: "驚きを表す感嘆詞" },
      { term: "eww", meaning: "嫌悪を表す感嘆詞" },
      { term: "oh!", meaning: "驚きを表す感嘆詞" },
      { term: "wow...", meaning: "驚きを表す感嘆詞" },
      { term: "cool", meaning: "かっこいい" },
    ];

    expect(filterPickupTerms(terms, { text: "ohhh hmmm wowww woah eww oh! wow... cool", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "cool", meaning: "かっこいい" },
    ]);
  });

  it("辞書の語に綴りが近いだけの語(ohm / uh-oh / boo / o7)は落とさない(issue #33)", () => {
    const terms = [
      { term: "ohm", meaning: "電気抵抗の単位" },
      { term: "uh-oh", meaning: "まずいことが起きたときの声" },
      { term: "boo", meaning: "ブーイング" },
      { term: "o7", meaning: "敬礼の顔文字" },
    ];

    expect(filterPickupTerms(terms, { text: "ohm uh-oh boo o7", emoteNames: [], mentionNames: [] })).toEqual(terms);
  });

  it("文字を伸ばした笑い声(hahaaa / HAHAHAAA)も落とす(issue #33)", () => {
    const terms = [
      { term: "hahaaa", meaning: "笑い声" },
      { term: "HAHAHAAA", meaning: "笑い声" },
      { term: "sticky", meaning: "スタン状態にする" },
    ];

    expect(filterPickupTerms(terms, { text: "hahaaa HAHAHAAA sticky", emoteNames: [], mentionNames: [] })).toEqual([
      { term: "sticky", meaning: "スタン状態にする" },
    ]);
  });

  it("相槌・感嘆詞を含む複数語の表現(oh my god / wow factor)は落とさない(issue #33)", () => {
    const terms = [
      { term: "oh my god", meaning: "なんてこった" },
      { term: "wow factor", meaning: "驚かせる要素" },
    ];

    expect(filterPickupTerms(terms, { text: "oh my god wow factor", emoteNames: [], mentionNames: [] })).toEqual(terms);
  });

  it("落とす対象が無ければ元の配列と同じ内容を返す", () => {
    const terms = [{ term: "sticky", meaning: "スタン状態にする" }];

    expect(filterPickupTerms(terms, 前処理済み)).toEqual(terms);
  });
});
