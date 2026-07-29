/**
 * src/lib/db/reviews.ts のテスト。
 *
 * fake-indexeddbを使い、採点(reviewCard)がSM-2状態の更新とreviews記録を
 * 不可分に(同一トランザクションで)行うこと、統計(getReviewStats)が
 * 復習件数・正答率を正しく計算することを検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./schema";
import { createCard } from "./cards";
import { getReviewStats, reviewCard } from "./reviews";

/** カード化ボタンから渡される入力を模したテストデータ(意味の分かる日本語・実チャット文を使用) */
function buildNewCardInput(overrides: Partial<Parameters<typeof createCard>[0]> = {}) {
  return {
    term: "GG",
    kind: "abbreviation" as const,
    meaning: "Good Game(お疲れさま、いい試合でした)の略語",
    note: "対戦系ゲームの配信終了時によく使われる",
    sourceMessageText: "GG everyone, that was such a clutch play!",
    sourceChannel: "zackrawrr",
    sourceAuthor: "yamada_taro",
    targetLang: "en" as const,
    explainLang: "ja" as const,
    tags: [],
    ...overrides,
  };
}

afterEach(async () => {
  await db.cards.clear();
  await db.reviews.clear();
});

describe("reviewCard", () => {
  it("SM-2状態を更新して保存し、reviewsに履歴を記録する", async () => {
    const card = await createCard(buildNewCardInput());
    const now = new Date("2026-07-29T12:00:00.000Z").getTime();

    const updated = await reviewCard(card.id!, "good", now);

    expect(updated.srs.interval).toBe(1);
    expect(updated.srs.repetitions).toBe(1);
    const stored = await db.cards.get(card.id!);
    expect(stored?.srs).toEqual(updated.srs);
    const reviews = await db.reviews.toArray();
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ cardId: card.id, grade: "good", reviewedAt: now });
  });

  it("存在しないカードIDを渡すとエラーを投げる", async () => {
    await expect(reviewCard(9999, "good", Date.now())).rejects.toThrow(/見つかりません/);
  });
});

describe("getReviewStats", () => {
  it("復習履歴がない場合は件数0・正答率0を返す", async () => {
    const stats = await getReviewStats();

    expect(stats).toEqual({ totalReviews: 0, correctRate: 0 });
  });

  it("Again以外の採点を正答とみなし、件数と正答率を計算する", async () => {
    const card = await createCard(buildNewCardInput());
    const now = new Date("2026-07-29T12:00:00.000Z").getTime();
    await reviewCard(card.id!, "good", now);
    await reviewCard(card.id!, "again", now + 1000);
    await reviewCard(card.id!, "easy", now + 2000);

    const stats = await getReviewStats();

    expect(stats.totalReviews).toBe(3);
    expect(stats.correctRate).toBeCloseTo(2 / 3);
  });
});
