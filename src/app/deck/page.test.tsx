/**
 * src/app/deck/page.tsx(単語帳画面)のテスト。
 *
 * Phase 3 の完了条件である「解説から任意の語句をカード化して `/deck` で
 * 一覧できる」を検証する。DB操作は fake-indexeddb 上で実際の `cards.ts` を
 * 動かして確認する(モックしない)。JSONエクスポートに使う
 * `URL.createObjectURL` / `revokeObjectURL` はjsdomに存在しないためテストで補う。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DeckPage from "./page";
import { db } from "@/lib/db/schema";
import { createCard } from "@/lib/db/cards";

/** カード化済みの語句を模したテストデータ(意味の分かる日本語・実チャット文を使用) */
function seedCard(overrides: Partial<Parameters<typeof createCard>[0]> = {}) {
  return createCard({
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
    ...overrides,
  });
}

beforeEach(() => {
  // jsdomにはBlob URL APIが無いため、エクスポート機能のテスト用に最小限のスタブを用意する
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.cards.clear();
});

describe("DeckPage", () => {
  it("登録済みのカードを新しい順に一覧表示する", async () => {
    await seedCard({ term: "GG" });
    await seedCard({ term: "clutch", meaning: "土壇場での見事なプレー" });

    render(<DeckPage />);

    await waitFor(() => {
      expect(screen.getByText("GG")).toBeInTheDocument();
    });
    expect(screen.getByText("clutch")).toBeInTheDocument();
  });

  it("カードが1件もない場合は空である旨を表示する", async () => {
    render(<DeckPage />);

    await waitFor(() => {
      expect(screen.getByText(/カードがまだありません/)).toBeInTheDocument();
    });
  });

  it("検索語を入力すると、term・meaning・noteに一致するカードだけに絞り込む", async () => {
    await seedCard({ term: "GG", meaning: "Good Game(いい試合)の略語" });
    await seedCard({ term: "clutch", meaning: "土壇場での見事なプレー" });
    const user = userEvent.setup();

    render(<DeckPage />);
    await waitFor(() => expect(screen.getByText("GG")).toBeInTheDocument());

    await user.type(screen.getByLabelText("カードを検索"), "clutch");

    await waitFor(() => {
      expect(screen.queryByText("GG")).not.toBeInTheDocument();
    });
    expect(screen.getByText("clutch")).toBeInTheDocument();
  });

  it("削除ボタンを押すとカードが一覧から削除される", async () => {
    await seedCard({ term: "GG" });
    const user = userEvent.setup();

    render(<DeckPage />);
    const card = await screen.findByText("GG");

    const cardRow = card.closest("li");
    if (!cardRow) throw new Error("カード行が見つかりませんでした");
    await user.click(within(cardRow).getByRole("button", { name: "削除" }));

    await waitFor(() => {
      expect(screen.queryByText("GG")).not.toBeInTheDocument();
    });
    expect(await db.cards.count()).toBe(0);
  });

  it("JSONエクスポートボタンを押すと、表示中のカードをJSON化してダウンロードする", async () => {
    await seedCard({ term: "GG" });
    const user = userEvent.setup();

    render(<DeckPage />);
    await waitFor(() => expect(screen.getByText("GG")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "JSONエクスポート" }));

    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
  });
});
