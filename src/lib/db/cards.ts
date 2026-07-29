/**
 * 単語帳カード(`Card`)のCRUDと検索・エクスポートを行うモジュール。
 *
 * 解説ダイアログの各語句候補(`ExplanationItem`)をカード化する際、および
 * `/deck` ページでの一覧・検索・削除・JSONエクスポートに使う。
 * データの永続化先は `schema.ts` の Dexie データベースのみとし、
 * サーバーへの送信は行わない。
 */
import type { Card, CardSrsState } from "./schema";
import { db } from "./schema";

/** SM-2の初期値。Phase 5「復習クイズ」で採点ロジックが状態を更新するまでの土台となる */
const INITIAL_EASE_FACTOR = 2.5;

/** カード作成時に渡す入力(id・createdAt・srsはこの関数側で採番・初期化する) */
export type NewCardInput = Omit<Card, "id" | "createdAt" | "srs">;

/** カード作成時点を「初回復習も即座に必要」とみなしたSM-2初期状態を組み立てる */
function createInitialSrsState(now: number): CardSrsState {
  return {
    due: now,
    interval: 0,
    easeFactor: INITIAL_EASE_FACTOR,
    repetitions: 0,
    lapses: 0,
    lastReviewedAt: null,
  };
}

/** カードを作成し、DBに保存したうえで保存内容(採番されたid・createdAt付き)を返す */
export async function createCard(input: NewCardInput): Promise<Card> {
  const now = Date.now();
  const card: Card = { ...input, createdAt: now, srs: createInitialSrsState(now) };
  const id = await db.cards.add(card);
  return { ...card, id };
}

/** 全カードを作成日時が新しい順に返す */
export async function listCards(): Promise<Card[]> {
  return db.cards.orderBy("createdAt").reverse().toArray();
}

/** term・meaning・noteのいずれかに部分一致(大文字小文字を区別しない)するカードを、作成日時が新しい順に返す */
export async function searchCards(query: string): Promise<Card[]> {
  const all = await listCards();
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery === "") {
    return all;
  }
  return all.filter((card) =>
    [card.term, card.meaning, card.note].some((field) => field.toLowerCase().includes(normalizedQuery)),
  );
}

/**
 * カード配列から、期日(srs.due)が現在時刻以下のものだけを期日が早い順に抽出する(DBアクセスなしの純関数)。
 * すでに全カードを取得済みの呼び出し元(復習クイズページなど)は、`listDueCards` で再度DBへ
 * 問い合わせる代わりにこちらを使うことで、同じテーブルへの重複スキャンを避けられる。
 */
export function selectDueCards(cards: Card[], now: number): Card[] {
  return cards.filter((card) => card.srs.due <= now).sort((a, b) => a.srs.due - b.srs.due);
}

/** 期日(srs.due)が現在時刻以下のカードを、期日が早い順に返す(復習クイズの出題対象取得に使う) */
export async function listDueCards(now: number): Promise<Card[]> {
  return selectDueCards(await db.cards.toArray(), now);
}

/** 指定したIDのカードを削除する */
export async function deleteCard(id: number): Promise<void> {
  await db.cards.delete(id);
}

/** カード配列を、そのままファイル保存できる整形済みJSON文字列に変換する(DBアクセスなしの純関数) */
export function exportCardsToJson(cards: Card[]): string {
  return JSON.stringify(cards, null, 2);
}
