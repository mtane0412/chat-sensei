/**
 * `srs.ts`(FSRSによる復習期日計算のラッパー。issue #113、ユーザー辞書構想 #107 の Phase 3)のテスト。
 *
 * Pick upの既出管理(`store/pickup-encounters.ts`)が使う復習期日計算を検証する。
 * 検証項目:
 * - 初回のGood評価でカードを作成し、復習期日が日単位の未来になる(分単位の学習ステップは使わない)
 * - 評価を重ねるごとに復習間隔が伸びる(間隔反復)
 * - Again評価(忘却シグナル)はGood評価より復習期日を近くする
 * - 計算が決定的である(同じ入力から同じ結果が得られる。ファズ無効)
 * - シリアライズ形式(数値のみ)が保存スキーマ(`srsCardSchema`)を満たす
 */
import { describe, expect, it } from "vitest";
import { Rating, reviewSrsCard, srsCardSchema } from "./srs";

/** テストの基準時刻(2026-09-04T12:00:00Z)。エポックミリ秒で扱う */
const BASE_NOW = new Date("2026-09-04T12:00:00Z").getTime();

const DAY_MS = 24 * 60 * 60 * 1000;

describe("reviewSrsCard", () => {
  it("カードが無い表現への初回Good評価でカードを作成し、復習期日が1日以上先になる(分単位の学習ステップを使わない)", () => {
    const card = reviewSrsCard(null, Rating.Good, BASE_NOW);

    // ts-fsrs 既定の学習ステップ(1分→10分)を使うと✓マーク直後の抑制が数分になってしまうため、
    // 学習ステップ無効(長期スケジュールのみ)で構成していることを検証する
    expect(card.due).toBeGreaterThanOrEqual(BASE_NOW + DAY_MS);
    // 初回評価の間隔として非常識に長くないことも確認する(暫定倍増規則の初回7日と同じ桁感)
    expect(card.due).toBeLessThanOrEqual(BASE_NOW + 60 * DAY_MS);
    expect(card.last_review).toBe(BASE_NOW);
  });

  it("復習期日が来るたびにGood評価を繰り返すと、復習間隔が単調に伸びる(間隔反復)", () => {
    const first = reviewSrsCard(null, Rating.Good, BASE_NOW);
    const firstInterval = first.due - BASE_NOW;

    // 1回目の復習期日ちょうどに再度Good評価する
    const second = reviewSrsCard(first, Rating.Good, first.due);
    const secondInterval = second.due - first.due;

    expect(secondInterval).toBeGreaterThan(firstInterval);
  });

  it("同じカード状態からの評価では、Again評価(忘れた)の復習期日がGood評価より近い", () => {
    const card = reviewSrsCard(null, Rating.Good, BASE_NOW);
    const reviewedAt = card.due;

    const again = reviewSrsCard(card, Rating.Again, reviewedAt);
    const good = reviewSrsCard(card, Rating.Good, reviewedAt);

    expect(again.due).toBeLessThan(good.due);
    // Againは忘却(lapse)として記録される
    expect(again.lapses).toBe(card.lapses + 1);
  });

  it("同じ入力からは常に同じ結果が得られる(ファズ無効・決定的)", () => {
    const first = reviewSrsCard(null, Rating.Good, BASE_NOW);
    const second = reviewSrsCard(null, Rating.Good, BASE_NOW);

    expect(second).toEqual(first);
  });

  it("計算結果は数値のみのシリアライズ形式で、保存スキーマを満たす(JSON経由の往復でも変わらない)", () => {
    const card = reviewSrsCard(null, Rating.Good, BASE_NOW);

    // localStorage への保存(JSON文字列化)と復元を経ても同じカードとして扱える
    const restored: unknown = JSON.parse(JSON.stringify(card));
    expect(srsCardSchema.parse(restored)).toEqual(card);

    // 復元したカードを次回の評価入力として使える
    const next = reviewSrsCard(srsCardSchema.parse(restored), Rating.Good, card.due);
    expect(next.due).toBeGreaterThan(card.due);
  });
});
