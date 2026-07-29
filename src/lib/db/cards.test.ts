/**
 * src/lib/db/cards.ts のテスト。
 *
 * fake-indexeddb(vitest.setup.ts で `fake-indexeddb/auto` を導入済み)を使い、
 * 実際のDexie APIに対してカードのCRUDとJSONエクスポートを検証する。
 * 各テストの独立性を保つため、テストごとに `db.cards` を空にしてから実行する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./schema";
import { createCard, deleteCard, exportCardsToJson, listCards, listDueCards, searchCards, selectDueCards } from "./cards";

/** カード化ボタンから渡される入力を模したテストデータ(意味の分かる日本語・実チャット文を使用) */
function buildNewCardInput(overrides: Partial<Parameters<typeof createCard>[0]> = {}) {
  return {
    term: "GG",
    kind: "abbreviation" as const,
    meaning: "Good Game(お疲れさま、いい試合でした)の略語",
    note: "対戦系ゲームの配信終了時や決着がついた直後によく使われる",
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
  vi.restoreAllMocks();
  await db.cards.clear();
});

describe("createCard", () => {
  it("id・作成日時・初期SRS状態を付与してカードを保存し、保存内容を返す", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-29T10:00:00.000Z").getTime());

    const created = await createCard(buildNewCardInput());

    expect(created.id).toBeTypeOf("number");
    expect(created.term).toBe("GG");
    expect(created.createdAt).toBe(new Date("2026-07-29T10:00:00.000Z").getTime());
    expect(created.srs).toEqual({
      due: new Date("2026-07-29T10:00:00.000Z").getTime(),
      interval: 0,
      easeFactor: 2.5,
      repetitions: 0,
      lapses: 0,
      lastReviewedAt: null,
    });

    const stored = await db.cards.get(created.id!);
    expect(stored).toEqual(created);
  });
});

describe("listCards", () => {
  it("作成日時が新しい順にカードを返す", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy.mockReturnValue(new Date("2026-07-29T10:00:00.000Z").getTime());
    const older = await createCard(buildNewCardInput({ term: "GG" }));
    dateNowSpy.mockReturnValue(new Date("2026-07-29T10:05:00.000Z").getTime());
    const newer = await createCard(buildNewCardInput({ term: "clutch" }));

    const list = await listCards();

    expect(list.map((card) => card.id)).toEqual([newer.id, older.id]);
  });
});

describe("searchCards", () => {
  it("term・meaning・noteの部分一致(大文字小文字を区別しない)でカードを絞り込む", async () => {
    await createCard(buildNewCardInput({ term: "GG", meaning: "Good Game(いい試合)の略語" }));
    await createCard(
      buildNewCardInput({ term: "clutch", meaning: "土壇場での見事なプレー", note: "実況者がよく使う表現" }),
    );

    const byTerm = await searchCards("gg");
    expect(byTerm.map((c) => c.term)).toEqual(["GG"]);

    const byNote = await searchCards("実況者");
    expect(byNote.map((c) => c.term)).toEqual(["clutch"]);
  });

  it("空文字で検索した場合は全カードを返す", async () => {
    await createCard(buildNewCardInput({ term: "GG" }));
    await createCard(buildNewCardInput({ term: "clutch" }));

    const result = await searchCards("");

    expect(result).toHaveLength(2);
  });
});

describe("listDueCards", () => {
  it("期日(srs.due)が現在時刻以下のカードだけを、期日が早い順に返す", async () => {
    const overdue = await createCard(buildNewCardInput({ term: "GG" }));
    const future = await createCard(buildNewCardInput({ term: "clutch" }));
    const moreOverdue = await createCard(buildNewCardInput({ term: "poggers" }));

    const now = new Date("2026-07-29T12:00:00.000Z").getTime();
    await db.cards.update(overdue.id!, { srs: { ...overdue.srs, due: now - 1000 } });
    await db.cards.update(future.id!, { srs: { ...future.srs, due: now + 1000 } });
    await db.cards.update(moreOverdue.id!, { srs: { ...moreOverdue.srs, due: now - 2000 } });

    const due = await listDueCards(now);

    expect(due.map((card) => card.term)).toEqual(["poggers", "GG"]);
  });
});

describe("selectDueCards", () => {
  it("カード配列から、期日(srs.due)が現在時刻以下のものだけを期日が早い順に抽出する(DBアクセスなしの純関数)", () => {
    const now = new Date("2026-07-29T12:00:00.000Z").getTime();
    const overdue = { ...buildNewCardInput({ term: "GG" }), id: 1, createdAt: 0, srs: { due: now - 1000, interval: 0, easeFactor: 2.5, repetitions: 0, lapses: 0, lastReviewedAt: null } };
    const future = { ...buildNewCardInput({ term: "clutch" }), id: 2, createdAt: 0, srs: { due: now + 1000, interval: 0, easeFactor: 2.5, repetitions: 0, lapses: 0, lastReviewedAt: null } };
    const moreOverdue = { ...buildNewCardInput({ term: "poggers" }), id: 3, createdAt: 0, srs: { due: now - 2000, interval: 0, easeFactor: 2.5, repetitions: 0, lapses: 0, lastReviewedAt: null } };

    const due = selectDueCards([overdue, future, moreOverdue], now);

    expect(due.map((card) => card.term)).toEqual(["poggers", "GG"]);
  });
});

describe("deleteCard", () => {
  it("指定したIDのカードを削除する", async () => {
    const created = await createCard(buildNewCardInput());

    await deleteCard(created.id!);

    const stored = await db.cards.get(created.id!);
    expect(stored).toBeUndefined();
  });
});

describe("exportCardsToJson", () => {
  it("カード配列を整形済みJSON文字列に変換する(DBアクセスなしの純関数)", () => {
    const card = { ...buildNewCardInput(), id: 1, createdAt: 0, srs: null } as unknown as Parameters<
      typeof exportCardsToJson
    >[0][number];

    const json = exportCardsToJson([card]);

    expect(JSON.parse(json)).toEqual([card]);
    expect(json).toContain("\n"); // 整形(pretty print)されていること
  });
});
