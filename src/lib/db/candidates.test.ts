/**
 * src/lib/db/candidates.ts のテスト。
 *
 * fake-indexeddb(vitest.setup.ts で `fake-indexeddb/auto` を導入済み)を使い、
 * 自動抽出パイプラインが生成した候補(Candidate)のCRUDと、
 * 採用(cardsへ移動)・却下(削除のみ)を検証する。
 * 各テストの独立性を保つため、テストごとに `db.candidates` / `db.cards` を空にしてから実行する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./schema";
import { acceptCandidate, createCandidate, listCandidates, rejectCandidate } from "./candidates";

/** 自動抽出パイプラインが生成する候補入力を模したテストデータ(意味の分かる日本語・実チャット文を使用) */
function buildNewCandidateInput(overrides: Partial<Parameters<typeof createCandidate>[0]> = {}) {
  return {
    term: "clutch",
    kind: "word" as const,
    meaning: "土壇場での見事なプレー",
    note: "対戦ゲームの実況・チャットでよく使われる",
    sourceMessageText: "that was such a clutch play honestly",
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
  await db.candidates.clear();
  await db.cards.clear();
});

describe("createCandidate", () => {
  it("id・作成日時を付与して候補を保存し、保存内容を返す", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-29T10:00:00.000Z").getTime());

    const created = await createCandidate(buildNewCandidateInput());

    expect(created.id).toBeTypeOf("number");
    expect(created.term).toBe("clutch");
    expect(created.createdAt).toBe(new Date("2026-07-29T10:00:00.000Z").getTime());

    const stored = await db.candidates.get(created.id!);
    expect(stored).toEqual(created);
  });
});

describe("listCandidates", () => {
  it("作成日時が新しい順に候補を返す", async () => {
    const dateNowSpy = vi.spyOn(Date, "now");
    dateNowSpy.mockReturnValue(new Date("2026-07-29T10:00:00.000Z").getTime());
    const older = await createCandidate(buildNewCandidateInput({ term: "clutch" }));
    dateNowSpy.mockReturnValue(new Date("2026-07-29T10:05:00.000Z").getTime());
    const newer = await createCandidate(buildNewCandidateInput({ term: "GG" }));

    const list = await listCandidates();

    expect(list.map((candidate) => candidate.id)).toEqual([newer.id, older.id]);
  });
});

describe("acceptCandidate", () => {
  it("候補を単語帳(cards)に保存し、候補自体は削除する", async () => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-07-29T10:00:00.000Z").getTime());
    const candidate = await createCandidate(buildNewCandidateInput());

    const card = await acceptCandidate(candidate.id!);

    expect(card.term).toBe("clutch");
    expect(card.meaning).toBe("土壇場での見事なプレー");
    expect(card.srs).toEqual({
      due: new Date("2026-07-29T10:00:00.000Z").getTime(),
      interval: 0,
      easeFactor: 2.5,
      repetitions: 0,
      lapses: 0,
      lastReviewedAt: null,
    });

    const storedCards = await db.cards.toArray();
    expect(storedCards).toHaveLength(1);
    expect(storedCards[0].term).toBe("clutch");

    const storedCandidate = await db.candidates.get(candidate.id!);
    expect(storedCandidate).toBeUndefined();
  });

  it("存在しない候補IDを指定した場合はエラーを投げ、cardsには何も保存されない", async () => {
    await expect(acceptCandidate(99999)).rejects.toThrow();

    const storedCards = await db.cards.toArray();
    expect(storedCards).toHaveLength(0);
  });
});

describe("rejectCandidate", () => {
  it("候補を削除するのみで、単語帳(cards)には保存しない", async () => {
    const candidate = await createCandidate(buildNewCandidateInput());

    await rejectCandidate(candidate.id!);

    const storedCandidate = await db.candidates.get(candidate.id!);
    expect(storedCandidate).toBeUndefined();
    const storedCards = await db.cards.toArray();
    expect(storedCards).toHaveLength(0);
  });
});
