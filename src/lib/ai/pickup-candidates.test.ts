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
import enExpressionList from "./data/en-expression-list.json";
import {
  createExpressionCandidateMatcher,
  EXCLUDED_CANDIDATE_EXPRESSIONS,
  findExpressionCandidates,
} from "./pickup-candidates";
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
  it("同梱の表現リストの表現(句動詞・定型接続表現)にマッチする", () => {
    // "give up" は Wiktionary 句動詞カテゴリ、"even though" は Wiktionary 接続詞カテゴリ由来
    expect(findExpressionCandidates("I kept playing even though I wanted to give up", "en")).toEqual([
      { term: "even though", expressionKey: buildTermExpressionKey("even though") },
      { term: "give up", expressionKey: buildTermExpressionKey("give up") },
    ]);
  });

  it("Wiktionary 未収載で手動補完リスト(CURATED_EXPRESSIONS)だけにある表現にもマッチする", () => {
    // "let him cook" は Wiktionary 由来リストに無いため、手動補完リストとの結線が切れるとマッチしなくなる
    expect(findExpressionCandidates("chat please let him cook", "en")).toEqual([
      { term: "let him cook", expressionKey: buildTermExpressionKey("let him cook") },
    ]);
  });

  it("機能語だけの断片の見出し語(of a / to the / and that 等)は候補にしない(issue #117 の実チャット評価)", () => {
    // 前提: Wiktionary の前置詞句・接続詞カテゴリには "of a" / "to the" / "and that" のような断片が収録されている。
    // 実チャットでは候補出現の約26%がこの種の断片で、学習価値が無いため候補生成の除外リストで落とす
    expect(findExpressionCandidates("it was kind of a long walk to the store and that was fine", "en")).toEqual([
      { term: "kind of", expressionKey: buildTermExpressionKey("kind of") },
    ]);
  });

  it("短縮形の除去で別の表現と同じ照合キーになる見出し語(i can't / i'll be / isn't it / being that)は候補にしない", () => {
    // 前提: 照合キーは n't や 'll を外して組み立てるため、"I can't" のキーは "I can" と同じになる。
    // 除外しないと、肯定の "I can" が否定の見出し語 "I can't" の候補として LLM に渡ってしまう
    expect(findExpressionCandidates("I can see it and I am sure it is that one, is it", "en")).toEqual([]);
  });

  it("除外リストと構成語が似ていても、学習価値のある機能語だけの表現(as if / so that)は候補に残す", () => {
    // 検証: 「全語が機能語なら一律に落とす」規則ではなく、個別の除外リストであること
    expect(findExpressionCandidates("he acts as if he knew, so that nobody asks", "en")).toEqual([
      { term: "as if", expressionKey: buildTermExpressionKey("as if") },
      { term: "so that", expressionKey: buildTermExpressionKey("so that") },
    ]);
  });

  it("除外リストの表現はすべて同梱の表現リストに実在する(リスト再生成で消えた項目を検出する)", () => {
    const listed = new Set(enExpressionList.expressions);
    expect(EXCLUDED_CANDIDATE_EXPRESSIONS.filter((expression) => !listed.has(expression))).toEqual([]);
  });

  it("学ぶ言語が en 以外の場合はリスト未整備のため空配列を返す", () => {
    expect(findExpressionCandidates("I want to give up", "ja")).toEqual([]);
  });
});
