/**
 * `stem.ts`(簡易レンマ化)のテスト。
 *
 * `stemForMatch` は語形変化した語(making / quests / went)と基本形(make / quest / go)を
 * 「同じ照合キー」に揃えるための決定的な関数である(issue #95)。
 * 言語学的に正しいレンマを返すことは目的ではなく、高頻度語リスト・表現リストの両側を
 * 同じ関数で正規化したときにキーが一致することだけを保証する。
 * そのためテストは「変化形と基本形が同じキーになる」ことを中心に検証する。
 */
import { describe, expect, it } from "vitest";
import { collapseElongatedLetters, collapseRepeatedLetters, splitIntoMatchWords, stemForMatch } from "./stem";

/** 変化形と基本形が同じ照合キーに揃うことを検証するヘルパー */
function expectSameKey(inflected: string, base: string) {
  expect(stemForMatch(inflected)).toBe(stemForMatch(base));
}

describe("stemForMatch", () => {
  it("変化の無い語はそのまま返す", () => {
    expect(stemForMatch("quest")).toBe("quest");
    expect(stemForMatch("troop")).toBe("troop");
  });

  it("大文字を含む語は小文字に揃える", () => {
    expect(stemForMatch("Quest")).toBe(stemForMatch("quest"));
    expect(stemForMatch("MAKING")).toBe(stemForMatch("make"));
  });

  it("複数形 -s / -es / -ies を基本形と同じキーに揃える", () => {
    expectSameKey("quests", "quest");
    expectSameKey("watches", "watch");
    expectSameKey("stories", "story");
    expectSameKey("goes", "go");
  });

  it("末尾が ss / us / is の語は複数形として s を外さない", () => {
    expect(stemForMatch("boss")).toBe("boss");
    expect(stemForMatch("bonus")).toBe("bonus");
    expect(stemForMatch("basis")).toBe("basis");
  });

  it("進行形 -ing を基本形と同じキーに揃える(語末の e の復元を含む)", () => {
    expectSameKey("making", "make");
    expectSameKey("giving", "give");
    expectSameKey("running", "run");
    expectSameKey("falling", "fall");
    expectSameKey("playing", "play");
  });

  it("-ing で終わる短い基本形(sing / bring)はそのまま返す", () => {
    expect(stemForMatch("sing")).toBe("sing");
    expect(stemForMatch("bring")).toBe("bring");
  });

  it("過去形 -ed を基本形と同じキーに揃える", () => {
    expectSameKey("played", "play");
    expectSameKey("liked", "like");
    expectSameKey("stopped", "stop");
    expectSameKey("tried", "try");
    expectSameKey("used", "use");
  });

  it("不規則動詞の変化形を基本形と同じキーに揃える", () => {
    expectSameKey("went", "go");
    expectSameKey("made", "make");
    expectSameKey("took", "take");
    expectSameKey("got", "get");
    expectSameKey("was", "be");
    expectSameKey("thought", "think");
    expectSameKey("gave", "give");
  });

  it("不規則名詞の複数形を単数形と同じキーに揃える", () => {
    expectSameKey("children", "child");
    expectSameKey("men", "man");
    expectSameKey("feet", "foot");
  });

  it("否定の短縮形を基本形と同じキーに揃える", () => {
    expectSameKey("don't", "do");
    expectSameKey("can't", "can");
    expectSameKey("won't", "will");
    expectSameKey("isn't", "be");
  });

  it("所有の 's を外して照合キーに揃える", () => {
    expectSameKey("streamer's", "streamer");
  });

  it("主語+助動詞の短縮形('ll / 're / 've / 'd / 'm)を主語側の語と同じキーに揃える(issue #115 の観測)", () => {
    // "almost it'll be" のようなリスト外のフラグメントが "it'll" 1語のせいで
    // 高頻度判定に乗らず残る誤検出を実チャットで観測したため、短縮形を外して照合する
    expectSameKey("it'll", "it");
    expectSameKey("i'll", "i");
    expectSameKey("you're", "you");
    expectSameKey("they've", "they");
    expectSameKey("he'd", "he");
    expectSameKey("i'm", "i");
  });

  it("三単現の -ies と基本形の -y を同じキーに揃える", () => {
    expectSameKey("tries", "try");
    expectSameKey("carries", "carry");
  });
});

describe("splitIntoMatchWords", () => {
  it("語句を空白で区切り、各語の前後の記号を外す", () => {
    expect(splitIntoMatchWords('"Give up!"')).toEqual(["Give", "up"]);
    expect(splitIntoMatchWords("no ifs, ands, or buts")).toEqual(["no", "ifs", "ands", "or", "buts"]);
  });

  it("語の内部のアポストロフィ・ハイフンは保持する", () => {
    expect(splitIntoMatchWords("don't sweat it")).toEqual(["don't", "sweat", "it"]);
    expect(splitIntoMatchWords("uh-oh moment")).toEqual(["uh-oh", "moment"]);
  });

  it("記号だけの語は除く", () => {
    expect(splitIntoMatchWords("wait ... what")).toEqual(["wait", "what"]);
  });
});

describe("collapseRepeatedLetters", () => {
  it("同じ文字の連続を1文字にまとめる(sooo → so / ohhh → oh)", () => {
    expect(collapseRepeatedLetters("sooo")).toBe("so");
    expect(collapseRepeatedLetters("ohhh")).toBe("oh");
    expect(collapseRepeatedLetters("hmmm")).toBe("hm");
  });

  it("連続の無い語はそのまま返す", () => {
    expect(collapseRepeatedLetters("sticky")).toBe("sticky");
    expect(collapseRepeatedLetters("haha")).toBe("haha");
  });

  it("正当な重ね字も潰れる(good → god)。呼び出し側は元の形と併用して照合すること", () => {
    expect(collapseRepeatedLetters("good")).toBe("god");
  });
});

describe("collapseElongatedLetters", () => {
  it("同じ文字の3回以上の連続だけを1文字にまとめる(sooo → so / niceee → nice)", () => {
    expect(collapseElongatedLetters("sooo")).toBe("so");
    expect(collapseElongatedLetters("niceee")).toBe("nice");
    expect(collapseElongatedLetters("yesss")).toBe("yes");
  });

  it("英語の正当な綴りに多い2文字連続は保持する(loot / weeb / good)", () => {
    expect(collapseElongatedLetters("loot")).toBe("loot");
    expect(collapseElongatedLetters("weeb")).toBe("weeb");
    expect(collapseElongatedLetters("good")).toBe("good");
  });
});
