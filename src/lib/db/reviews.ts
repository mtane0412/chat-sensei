/**
 * 復習履歴(`Review`)の記録とSM-2状態の更新を行うモジュール。
 *
 * 復習クイズ(/study)で1問答えるたびに `reviewCard` を呼ぶ。`gradeCard`(SM-2純関数)で
 * カードのSRS状態を更新し、同じDexieトランザクション内で `reviews` に採点結果を記録する
 * ことで、「カードは更新されたが履歴が残らない」といった中途半端な状態を避ける。
 */
import type { Card } from "./schema";
import { db } from "./schema";
import { gradeCard, type Grade } from "./srs";

/** 学習統計(復習件数・正答率) */
export interface ReviewStats {
  totalReviews: number;
  /** Again以外の採点を正答とみなした割合(0〜1)。復習履歴がない場合は0 */
  correctRate: number;
}

/**
 * カードを採点する: SM-2状態(`gradeCard`)を更新して保存し、reviewsに履歴を記録する。
 * 更新後のカード(新しいsrsを含む)を返す。
 */
export async function reviewCard(cardId: number, grade: Grade, now: number): Promise<Card> {
  return db.transaction("rw", db.cards, db.reviews, async () => {
    const card = await db.cards.get(cardId);
    if (!card) {
      throw new Error(`カードが見つかりません(id: ${cardId})`);
    }

    const srs = gradeCard(card.srs, grade, now);
    await db.cards.update(cardId, { srs });
    await db.reviews.add({ cardId, grade, reviewedAt: now });

    return { ...card, srs };
  });
}

/** 全復習履歴から件数・正答率(Again以外を正答とみなす)を計算する */
export async function getReviewStats(): Promise<ReviewStats> {
  const reviews = await db.reviews.toArray();
  if (reviews.length === 0) {
    return { totalReviews: 0, correctRate: 0 };
  }
  const correctCount = reviews.filter((review) => review.grade !== "again").length;
  return { totalReviews: reviews.length, correctRate: correctCount / reviews.length };
}
