/**
 * `pickup-candidate-stats.ts`(Pick up 候補生成の実チャット評価の集計。issue #117)のテスト。
 *
 * 1発言ごとの候補(表現キーの配列)を入力に、件数分布・注入上限の超過件数・頻出表現・
 * クールダウンのシミュレーション結果を返す純関数を検証する。
 * テストデータの表現キーは創作したもので、実チャットの内容は含まない。
 */
import { describe, expect, it } from "vitest";
import { type CandidateObservation, summarizeCandidateObservations } from "./pickup-candidate-stats";

/** 分をミリ秒に変換するヘルパー */
function minutes(value: number): number {
  return value * 60 * 1000;
}

/** テスト用の観測データを組み立てるヘルパー。`atMinute` は配信開始からの経過分 */
function observation(atMinute: number, ...expressionKeys: string[]): CandidateObservation {
  return { timestampMs: minutes(atMinute), expressionKeys };
}

const OPTIONS = { injectionLimits: [2, 3], cooldownMs: minutes(30), topExpressionCount: 2 };

describe("summarizeCandidateObservations", () => {
  it("発言数・候補ありの発言数・候補の総数を数える", () => {
    // 前提: 3発言のうち候補があるのは2発言(2件 + 1件)
    const stats = summarizeCandidateObservations(
      [observation(0, "giv up", "even though"), observation(1), observation(2, "no cap")],
      OPTIONS,
    );
    expect(stats.messageCount).toBe(3);
    expect(stats.messagesWithCandidates).toBe(2);
    expect(stats.totalCandidateCount).toBe(3);
  });

  it("1発言あたりの候補件数の分布を、件数の昇順で返す", () => {
    // 前提: 候補0件が2発言、1件が1発言、3件が1発言
    const stats = summarizeCandidateObservations(
      [observation(0), observation(1), observation(2, "no cap"), observation(3, "giv up", "even though", "for real")],
      OPTIONS,
    );
    expect(stats.candidateCountDistribution).toEqual([
      { candidateCount: 0, messageCount: 2 },
      { candidateCount: 1, messageCount: 1 },
      { candidateCount: 3, messageCount: 1 },
    ]);
    expect(stats.maxCandidateCount).toBe(3);
  });

  it("注入上限ごとに、候補件数が上限を超える(切り捨てが発生する)発言数を数える", () => {
    // 前提: 候補3件の発言が1つ。上限2なら超過、上限3なら超過しない
    const stats = summarizeCandidateObservations(
      [observation(0, "giv up", "even though", "for real"), observation(1, "no cap")],
      OPTIONS,
    );
    expect(stats.overInjectionLimit).toEqual([
      { limit: 2, messageCount: 1 },
      { limit: 3, messageCount: 0 },
    ]);
  });

  it("頻出表現を出現回数の降順(同数は表現キーの昇順)で上位N件だけ返す", () => {
    // 前提: "no cap" が3回、"for real" と "giv up" が1回ずつ。上位2件を要求
    const stats = summarizeCandidateObservations(
      [observation(0, "no cap", "giv up"), observation(1, "no cap", "for real"), observation(2, "no cap")],
      OPTIONS,
    );
    expect(stats.topExpressions).toEqual([
      { expressionKey: "no cap", occurrences: 3 },
      { expressionKey: "for real", occurrences: 1 },
    ]);
    expect(stats.distinctExpressionCount).toBe(3);
  });

  it("クールダウンのシミュレーション: 最終表示からクールダウン内の再出現は抑制として数える", () => {
    // 前提: "no cap" が 0分(初回表示)・10分(抑制)・45分(再表示)に出現。クールダウンは30分
    const stats = summarizeCandidateObservations(
      [observation(0, "no cap"), observation(10, "no cap"), observation(45, "no cap")],
      OPTIONS,
    );
    expect(stats.cooldown).toEqual({ shownCount: 2, suppressedCount: 1, reshownCount: 1 });
  });

  it("クールダウンのシミュレーション: 抑制された出現は最終表示日時を更新しない(既出管理の実装と同じ)", () => {
    // 前提: 0分に表示、20分に抑制。35分は「最終表示(0分)から30分超」のため再表示される。
    // 20分の抑制で最終表示日時を更新してしまうと、35分も抑制されて shownCount が 1 になる
    const stats = summarizeCandidateObservations(
      [observation(0, "no cap"), observation(20, "no cap"), observation(35, "no cap")],
      OPTIONS,
    );
    expect(stats.cooldown).toEqual({ shownCount: 2, suppressedCount: 1, reshownCount: 1 });
  });

  it("観測データが時刻順に並んでいなくても、時刻の昇順に並べ直してシミュレーションする", () => {
    // 前提: 45分・0分・10分の順で渡す。並べ直さないと 0分・10分の出現が「過去への再出現」になり結果が狂う
    const stats = summarizeCandidateObservations(
      [observation(45, "no cap"), observation(0, "no cap"), observation(10, "no cap")],
      OPTIONS,
    );
    expect(stats.cooldown).toEqual({ shownCount: 2, suppressedCount: 1, reshownCount: 1 });
  });

  it("観測データが空でも例外を投げず、すべて0の集計を返す", () => {
    const stats = summarizeCandidateObservations([], OPTIONS);
    expect(stats.messageCount).toBe(0);
    expect(stats.maxCandidateCount).toBe(0);
    expect(stats.candidateCountDistribution).toEqual([]);
    expect(stats.cooldown).toEqual({ shownCount: 0, suppressedCount: 0, reshownCount: 0 });
  });
});
