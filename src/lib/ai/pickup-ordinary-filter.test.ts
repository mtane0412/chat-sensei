/**
 * `pickup-ordinary-filter.ts`(普通の単語・字義通りの句を落とすハイブリッドフィルタ。issue #95)のテスト。
 *
 * Gemini Nano はプロンプトで「普通の単語を含めない」と指示しても "rare" / "main quests" のような
 * 普通の語句を返すため、高頻度語リスト(NGSL)と表現リスト(Wiktionary 句動詞・イディオム)を使った
 * 決定的なフィルタで落とす。判定規則:
 * - 1語: 高頻度語リストにあれば落とす(スラング・Twitch用語のような非高頻度語は残す)
 * - 複数語: 表現リストに(レンマ正規化して)あれば残す。リスト外で全語が高頻度なら落とす。
 *   1語でも非高頻度語を含めば残す
 *
 * ゴールデンセット: 実際の配信チャットの逆方向 Pick up で観測した誤抽出(issue #95 の実例)を
 * 回帰テストとして固定する。
 */
import { describe, expect, it } from "vitest";
import { filterOrdinaryTerms } from "./pickup-ordinary-filter";
import type { PickupTerm } from "./schemas";

/** テストデータ組み立てヘルパー。意味の文字列は判定に影響しない */
function terms(...termTexts: string[]): PickupTerm[] {
  return termTexts.map((term) => ({ term, meaning: "テスト用の意味" }));
}

/** 語句の配列からフィルタ通過後の語句だけを取り出すヘルパー */
function survivingTerms(termTexts: string[], learningLang: Parameters<typeof filterOrdinaryTerms>[1] = "en"): string[] {
  return filterOrdinaryTerms(terms(...termTexts), learningLang).map((item) => item.term);
}

describe("filterOrdinaryTerms", () => {
  it("高頻度語リストにある1語の語句を落とす(issue #95 のゴールデンセット)", () => {
    expect(survivingTerms(["rare", "troop", "alongside"])).toEqual([]);
  });

  it("高頻度語リストに無い1語のスラング・Twitch用語は残す", () => {
    expect(survivingTerms(["lol", "malding", "raid", "emote", "sub"])).toEqual([
      "lol",
      "malding",
      "raid",
      "emote",
      "sub",
    ]);
  });

  it("表現リストに無く全語が高頻度語の複数語句を落とす(issue #95 のゴールデンセット)", () => {
    expect(survivingTerms(["main quests", "everything else"])).toEqual([]);
  });

  it("表現リストにある複数語の表現(句動詞・イディオム)は全語が高頻度語でも残す", () => {
    expect(survivingTerms(["give up", "check out", "make a mountain out of a molehill"])).toEqual([
      "give up",
      "check out",
      "make a mountain out of a molehill",
    ]);
  });

  it("表現リストの照合はレンマ正規化して行う(making → make)", () => {
    expect(survivingTerms(["making a mountain out of a molehill", "gave up"])).toEqual([
      "making a mountain out of a molehill",
      "gave up",
    ]);
  });

  it("スラング系カテゴリ由来の複数語スラングは全語が高頻度語でも残す", () => {
    expect(survivingTerms(["no cap", "for real", "touch grass"])).toEqual(["no cap", "for real", "touch grass"]);
  });

  it("Wiktionary 未収載のミーム表現も手動補完リストにあれば残す", () => {
    expect(survivingTerms(["let him cook", "on god"])).toEqual(["let him cook", "on god"]);
  });

  it("手動補完した定型接続表現・コロケーションは残す", () => {
    expect(survivingTerms(["even though", "as well as", "put effort into"])).toEqual([
      "even though",
      "as well as",
      "put effort into",
    ]);
  });

  it("非高頻度語を含む複数語句は表現リストに無くても残す", () => {
    expect(survivingTerms(["malding hard", "clip it"])).toEqual(["malding hard", "clip it"]);
  });

  it("照合は大文字小文字を区別せず、語句の前後の記号は無視する", () => {
    expect(survivingTerms(["Rare", '"main quests"', "Give up!"])).toEqual(["Give up!"]);
  });

  it("変化形の1語も高頻度語として落とす(quests → quest は手動補完の高頻度語)", () => {
    expect(survivingTerms(["quests", "streamers"])).toEqual([]);
  });

  it("伸ばし字の1語(sooo / niceee)は同一文字の連続を潰した形でも照合して落とす(issue #97)", () => {
    expect(survivingTerms(["sooo", "niceee", "yesss"])).toEqual([]);
  });

  it("伸ばし字を含む複数語句(sooo good)も潰した形の照合で全語が高頻度なら落とす(issue #97)", () => {
    expect(survivingTerms(["sooo good"])).toEqual([]);
  });

  it("潰した形が高頻度語に一致しても、潰す前の形で高頻度語に一致する語は従来どおり落とす(good → god の誤変換で残さない)", () => {
    // "good" を潰すと "god" になるが、元の形 "good" 自体が高頻度語のため落ちる
    expect(survivingTerms(["good"])).toEqual([]);
  });

  it("潰しても高頻度語に一致しない伸ばしスラング(maldinggg)は残す(issue #97)", () => {
    expect(survivingTerms(["maldinggg"])).toEqual(["maldinggg"]);
  });

  it("学ぶ言語が en 以外の場合はリスト未整備のため何も落とさない", () => {
    expect(survivingTerms(["rare", "main quests"], "ja")).toEqual(["rare", "main quests"]);
    expect(survivingTerms(["rare", "main quests"], "fr")).toEqual(["rare", "main quests"]);
  });
});
