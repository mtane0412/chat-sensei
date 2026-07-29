/**
 * IndexedDB(Dexie)に保存された全データを削除するモジュール。
 *
 * 設定画面(/settings)の「データを全て削除する」機能から呼ばれる。
 * `messages` / `cards` / `reviews` / `candidates` の全テーブルを、
 * 「一部だけ消えて一部残る」中途半端な状態を避けるため、
 * ひとつのDexieトランザクションとして不可分に削除する。
 */
import { db } from "./schema";

/** IndexedDBの全テーブル(messages・cards・reviews・candidates)を空にする */
export async function clearAllIndexedDbData(): Promise<void> {
  await db.transaction("rw", db.messages, db.cards, db.reviews, db.candidates, async () => {
    await Promise.all([db.messages.clear(), db.cards.clear(), db.reviews.clear(), db.candidates.clear()]);
  });
}
