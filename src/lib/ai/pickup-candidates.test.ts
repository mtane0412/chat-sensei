/**
 * `pickup-candidates.ts`(表現リストによる決定的な候補生成器。issue #115 / 親 #112)のテスト。
 *
 * チャット本文を `stem.ts` の正規化で語に分割し、表現リストの照合キーに対して連続 n-gram で
 * 照合して、本文中に現れた学習表現の候補を決定的に列挙する。LLM 非依存の純関数であること、
 * 語形変化・大文字・前後の記号の揺れを吸収すること、最長一致を優先することを検証する。
 *
 * `createExpressionCandidateMatcher` は表現リストを注入できるファクトリで、テストは小さな
 * リストで規則を検証する。`findExpressionCandidates` は同梱リスト(Wiktionary 由来 +
 * `CURATED_EXPRESSIONS`)から組み立てた既定のマッチャーで、同梱データとの結線を検証する。
 */
import { describe, expect, it } from "vitest";
import { createExpressionCandidateMatcher, findExpressionCandidates } from "./pickup-candidates";
import { buildTermExpressionKey } from "./pickup-ordinary-filter";

describe("createExpressionCandidateMatcher", () => {
  it("本文中の表現リストの表現にマッチし、表面形と表現キーを返す", () => {
    const match = createExpressionCandidateMatcher(["give up", "even though"]);
    expect(match("I will never give up on this quest")).toEqual([
      { term: "give up", expressionKey: buildTermExpressionKey("give up") },
    ]);
  });

  it("語形変化・大文字・前後の記号の揺れがあってもマッチし、表面形は本文の表記を保つ", () => {
    const match = createExpressionCandidateMatcher(["give up", "even though"]);
    // "Gave up!!" は過去形 + 感嘆符付きだが、レンマ正規化で "give up" と同じキーになる
    expect(match("He Gave up!! already")).toEqual([
      { term: "Gave up", expressionKey: buildTermExpressionKey("give up") },
    ]);
  });

  it("別の候補に完全に包含される候補は最長一致を優先して落とす", () => {
    const match = createExpressionCandidateMatcher(["no matter", "no matter what"]);
    expect(match("no matter what happens")).toEqual([
      { term: "no matter what", expressionKey: buildTermExpressionKey("no matter what") },
    ]);
  });

  it("部分的に重なるだけで包含関係に無い候補は両方残す", () => {
    // "come on" と "on top of" は "on" を共有するが、どちらも他方に包含されない
    const match = createExpressionCandidateMatcher(["come on", "on top of"]);
    expect(match("come on top of the hill")).toEqual([
      { term: "come on", expressionKey: buildTermExpressionKey("come on") },
      { term: "on top of", expressionKey: buildTermExpressionKey("on top of") },
    ]);
  });

  it("同じ表現が本文に複数回現れても候補は1件にまとめる", () => {
    const match = createExpressionCandidateMatcher(["give up"]);
    expect(match("give up give up give up")).toEqual([
      { term: "give up", expressionKey: buildTermExpressionKey("give up") },
    ]);
  });

  it("マッチする表現が無い本文には空配列を返す", () => {
    const match = createExpressionCandidateMatcher(["give up"]);
    expect(match("hello world")).toEqual([]);
  });

  it("リスト上の1語の表現は候補にしない(1語は高頻度語リスト側の判定に委ねる)", () => {
    const match = createExpressionCandidateMatcher(["lol"]);
    expect(match("lol that was funny")).toEqual([]);
  });

  it("本文の語数より長い表現があってもエラーにならない", () => {
    const match = createExpressionCandidateMatcher(["make a mountain out of a molehill"]);
    expect(match("a molehill")).toEqual([]);
  });
});

describe("findExpressionCandidates", () => {
  it("同梱の表現リストの表現(句動詞・手動補完の定型接続表現)にマッチする", () => {
    // "give up" は Wiktionary 句動詞カテゴリ、"even though" は CURATED_EXPRESSIONS 由来
    expect(findExpressionCandidates("I kept playing even though I wanted to give up", "en")).toEqual([
      { term: "even though", expressionKey: buildTermExpressionKey("even though") },
      { term: "give up", expressionKey: buildTermExpressionKey("give up") },
    ]);
  });

  it("学ぶ言語が en 以外の場合はリスト未整備のため空配列を返す", () => {
    expect(findExpressionCandidates("I want to give up", "ja")).toEqual([]);
  });
});
