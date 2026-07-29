/**
 * src/lib/db/reset.ts のテスト。
 *
 * 設定画面(/settings)の「データを全て削除する」機能から呼び出される、
 * IndexedDB(Dexie)の全テーブルを削除する処理を検証する。
 * fake-indexeddb(vitest.setup.ts で `fake-indexeddb/auto` を導入済み)を使い、
 * 実際のDexie APIに対して検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./schema";
import { clearAllIndexedDbData } from "./reset";

afterEach(async () => {
  await Promise.all([db.messages.clear(), db.cards.clear(), db.reviews.clear(), db.candidates.clear()]);
});

describe("clearAllIndexedDbData", () => {
  it("messages・cards・reviews・candidatesの全レコードを削除する", async () => {
    await db.messages.add({
      channel: "zackrawrr",
      userId: "987654",
      displayName: "CodeChamp92",
      color: "#1E90FF",
      text: "gg chat",
      emotes: [],
      timestampMs: 1690000000000,
      detectedLang: "en",
      confidence: 0.9,
    });
    const cardId = await db.cards.add({
      term: "GG",
      kind: "abbreviation",
      meaning: "Good Game(お疲れさま、いい試合でした)の略語",
      note: "対戦系ゲームの配信終了時によく使われる",
      sourceMessageText: "GG everyone, that was such a clutch play!",
      sourceChannel: "zackrawrr",
      sourceAuthor: "yamada_taro",
      targetLang: "en",
      explainLang: "ja",
      tags: [],
      createdAt: 1690000000000,
      srs: { due: 1690000000000, interval: 0, easeFactor: 2.5, repetitions: 0, lapses: 0, lastReviewedAt: null },
    });
    await db.reviews.add({ cardId, grade: "good", reviewedAt: 1690000000000 });
    await db.candidates.add({
      term: "clutch",
      kind: "slang",
      meaning: "土壇場での好プレイ",
      note: "劣勢からの逆転プレイに使われる",
      sourceMessageText: "that was such a clutch play honestly",
      sourceChannel: "zackrawrr",
      sourceAuthor: "yamada_taro",
      targetLang: "en",
      explainLang: "ja",
      tags: [],
      createdAt: 1690000000000,
    });

    await clearAllIndexedDbData();

    expect(await db.messages.count()).toBe(0);
    expect(await db.cards.count()).toBe(0);
    expect(await db.reviews.count()).toBe(0);
    expect(await db.candidates.count()).toBe(0);
  });
});
