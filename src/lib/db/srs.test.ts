/**
 * src/lib/db/srs.ts のテスト。
 *
 * SM-2相当のアルゴリズムをDBアクセスなしの純関数として検証する。
 * 「初回復習も即座に必要」とみなす初期状態(cards.ts の createInitialSrsState 相当)から、
 * 各採点(Again/Hard/Good/Easy)でinterval・easeFactor・repetitions・lapsesがどう遷移するかを確認する。
 */
import { describe, expect, it } from "vitest";
import { gradeCard } from "./srs";
import type { CardSrsState } from "./schema";

/** 未復習カードの初期SRS状態を模したテストデータ */
function buildInitialSrsState(overrides: Partial<CardSrsState> = {}): CardSrsState {
  return {
    due: 0,
    interval: 0,
    easeFactor: 2.5,
    repetitions: 0,
    lapses: 0,
    lastReviewedAt: null,
    ...overrides,
  };
}

const NOW = new Date("2026-07-29T10:00:00.000Z").getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

describe("gradeCard", () => {
  it("初回にGoodと採点すると、1日後が次回期日になりrepetitionsが1になる", () => {
    const result = gradeCard(buildInitialSrsState(), "good", NOW);

    expect(result.interval).toBe(1);
    expect(result.due).toBe(NOW + 1 * DAY_MS);
    expect(result.repetitions).toBe(1);
    expect(result.easeFactor).toBe(2.5);
    expect(result.lapses).toBe(0);
    expect(result.lastReviewedAt).toBe(NOW);
  });

  it("2回目のGoodで6日後になる", () => {
    const first = gradeCard(buildInitialSrsState(), "good", NOW);

    const second = gradeCard(first, "good", NOW + DAY_MS);

    expect(second.interval).toBe(6);
    expect(second.repetitions).toBe(2);
  });

  it("3回目以降のGoodは、旧intervalに旧easeFactorを掛けて伸びる", () => {
    const state = buildInitialSrsState({ interval: 6, repetitions: 2, easeFactor: 2.5 });

    const result = gradeCard(state, "good", NOW);

    expect(result.interval).toBe(15); // 6 * 2.5
    expect(result.repetitions).toBe(3);
    expect(result.easeFactor).toBe(2.5); // Goodはease増減なし
  });

  it("Againと採点すると、即座に再出題対象になりrepetitions/intervalがリセットされ、lapsesが増える", () => {
    const state = buildInitialSrsState({ interval: 15, repetitions: 3, easeFactor: 2.5, lapses: 1 });

    const result = gradeCard(state, "again", NOW);

    expect(result.due).toBe(NOW);
    expect(result.interval).toBe(0);
    expect(result.repetitions).toBe(0);
    expect(result.lapses).toBe(2);
    expect(result.easeFactor).toBeCloseTo(2.3); // 2.5 - 0.2
    expect(result.lastReviewedAt).toBe(NOW);
  });

  it("easeFactorは1.3を下回らない", () => {
    const state = buildInitialSrsState({ easeFactor: 1.35 });

    const result = gradeCard(state, "again", NOW);

    expect(result.easeFactor).toBe(1.3);
  });

  it("初回にHardと採点すると1日後になり、easeFactorが0.15下がる", () => {
    const result = gradeCard(buildInitialSrsState(), "hard", NOW);

    expect(result.interval).toBe(1);
    expect(result.repetitions).toBe(1);
    expect(result.easeFactor).toBeCloseTo(2.35);
  });

  it("3回目以降のHardは、easeFactorに依存せずintervalを1.2倍する", () => {
    const state = buildInitialSrsState({ interval: 10, repetitions: 2, easeFactor: 2.0 });

    const result = gradeCard(state, "hard", NOW);

    expect(result.interval).toBe(12); // 10 * 1.2
    expect(result.easeFactor).toBeCloseTo(1.85);
  });

  it("初回にEasyと採点すると4日後になり、easeFactorが0.15上がる", () => {
    const result = gradeCard(buildInitialSrsState(), "easy", NOW);

    expect(result.interval).toBe(4);
    expect(result.repetitions).toBe(1);
    expect(result.easeFactor).toBeCloseTo(2.65);
  });

  it("3回目以降のEasyは、旧easeFactorに1.3倍のボーナスを掛けて大きく伸びる", () => {
    const state = buildInitialSrsState({ interval: 6, repetitions: 2, easeFactor: 2.5 });

    const result = gradeCard(state, "easy", NOW);

    expect(result.interval).toBe(20); // round(6 * 2.5 * 1.3) = round(19.5) = 20
    expect(result.easeFactor).toBeCloseTo(2.65);
  });
});
