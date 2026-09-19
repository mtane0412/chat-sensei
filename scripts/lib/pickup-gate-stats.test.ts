/**
 * `pickup-gate-stats.ts`(Pick up 候補の採否ゲートの比較検証の集計。issue #123)のテスト。
 *
 * 人手ラベル付きの候補に対するゲートの判定(慣用表現として使われている確率)を入力に、
 * 字義通り一致の除去率・誤除去率と、2つの採否判定の一致度を返す純関数を検証する。
 * テストデータの表現キーは創作したもので、実チャットの内容は含まない。
 */
import { describe, expect, it } from "vitest";
import {
  type GateJudgment,
  summarizeAgreement,
  summarizeGateJudgments,
  summarizeLatencies,
} from "./pickup-gate-stats";

/** テスト用の判定データを組み立てるヘルパー */
function judgment(label: GateJudgment["label"], idiomaticProbability: number): GateJudgment {
  return { expressionKey: "giv up", label, idiomaticProbability };
}

describe("summarizeGateJudgments", () => {
  it("字義通り一致(literal)のうち、確率が閾値未満で除去された割合を除去率として返す", () => {
    // 前提: 字義通り一致4件のうち、閾値0.5未満は3件
    const summary = summarizeGateJudgments(
      [judgment("literal", 0.1), judgment("literal", 0.2), judgment("literal", 0.49), judgment("literal", 0.9)],
      0.5,
    );
    expect(summary.literal).toEqual({ total: 4, removed: 3, removalRate: 0.75 });
  });

  it("基本表現(basic)と学習価値あり(valuable)は、除去された割合を誤除去率として別々に返す", () => {
    // 前提: 基本表現2件のうち1件、学習価値あり4件のうち1件が閾値未満
    const summary = summarizeGateJudgments(
      [
        judgment("basic", 0.3),
        judgment("basic", 0.8),
        judgment("valuable", 0.4),
        judgment("valuable", 0.6),
        judgment("valuable", 0.7),
        judgment("valuable", 0.95),
      ],
      0.5,
    );
    expect(summary.basic).toEqual({ total: 2, removed: 1, removalRate: 0.5 });
    expect(summary.valuable).toEqual({ total: 4, removed: 1, removalRate: 0.25 });
  });

  it("確率が閾値ちょうどの候補は残す(除去しない)", () => {
    const summary = summarizeGateJudgments([judgment("literal", 0.5)], 0.5);
    expect(summary.literal.removed).toBe(0);
  });

  it("該当ラベルの候補が0件のとき、除去率は null を返す(0除算の結果を率として見せない)", () => {
    const summary = summarizeGateJudgments([judgment("literal", 0.1)], 0.5);
    expect(summary.valuable).toEqual({ total: 0, removed: 0, removalRate: null });
  });

  it("閾値を返り値に含める(複数の閾値で集計した結果を見分けるため)", () => {
    expect(summarizeGateJudgments([], 0.3).threshold).toBe(0.3);
  });
});

describe("summarizeAgreement", () => {
  it("2つの採否判定が一致した件数と一致率、および2×2の内訳を返す", () => {
    // 前提: 5件のうち、両方採用2件・両方不採用1件・ゲートだけ採用1件・LLMだけ採用1件
    const agreement = summarizeAgreement([
      { gateKeeps: true, llmKeeps: true },
      { gateKeeps: true, llmKeeps: true },
      { gateKeeps: false, llmKeeps: false },
      { gateKeeps: true, llmKeeps: false },
      { gateKeeps: false, llmKeeps: true },
    ]);
    expect(agreement).toEqual({
      total: 5,
      bothKeep: 2,
      bothDrop: 1,
      onlyGateKeeps: 1,
      onlyLlmKeeps: 1,
      agreementRate: 0.6,
    });
  });

  it("比較対象が0件のとき、一致率は null を返す", () => {
    expect(summarizeAgreement([]).agreementRate).toBeNull();
  });
});

describe("summarizeLatencies", () => {
  it("1発言あたりの追加時間の平均・中央値・95パーセンタイル・最大を返す", () => {
    // 前提: 10件の計測値(ミリ秒)。95パーセンタイルは、値を昇順に並べた上位5%の境目(最近傍法)で10番目の値
    const summary = summarizeLatencies([100, 110, 120, 130, 140, 150, 160, 170, 180, 1000]);
    expect(summary).toEqual({ count: 10, meanMs: 226, medianMs: 140, p95Ms: 1000, maxMs: 1000 });
  });

  it("入力の並び順に依存しない", () => {
    expect(summarizeLatencies([300, 100, 200]).medianMs).toBe(200);
  });

  it("計測値が0件のときはエラーにする(率や時間を捏造しない)", () => {
    expect(() => summarizeLatencies([])).toThrow("計測値が0件");
  });
});
