/**
 * src/app/study/page.tsx(復習クイズ画面)のテスト。
 *
 * Phase 5の完了条件である「期日が来たカードだけが出題され、成績で次回間隔が変わる」を、
 * fake-indexeddb上で実際の `cards.ts` / `reviews.ts` / `quiz.ts` を動かして検証する
 * (復習クイズはLLM非依存の設計のためモック不要)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import StudyPage from "./page";
import { db } from "@/lib/db/schema";
import { createCard } from "@/lib/db/cards";
import * as cardsModule from "@/lib/db/cards";
import * as reviewsModule from "@/lib/db/reviews";

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

afterEach(async () => {
  vi.restoreAllMocks();
  await db.cards.clear();
  await db.reviews.clear();
});

describe("StudyPage", () => {
  it("復習対象のカードが1件もない場合、その旨を表示する", async () => {
    render(<StudyPage />);

    await waitFor(() => {
      expect(screen.getByText(/復習するカードはありません/)).toBeInTheDocument();
    });
  });

  it("穴埋め問題に正解すると正誤が表示され、採点後に復習セッションが終了する", async () => {
    await seedCard({
      term: "clutch",
      meaning: "土壇場での見事なプレー",
      sourceMessageText: "that was such a clutch play honestly",
    });
    const user = userEvent.setup();

    render(<StudyPage />);

    await waitFor(() => expect(screen.getByLabelText("答えを入力")).toBeInTheDocument());
    await user.type(screen.getByLabelText("答えを入力"), "clutch");
    await user.click(screen.getByRole("button", { name: "判定する" }));

    await waitFor(() => expect(screen.getByText("正解!")).toBeInTheDocument());
    expect(screen.getByText("土壇場での見事なプレー")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "普通" }));

    await waitFor(() => {
      expect(screen.getByText(/復習セッションが終了しました/)).toBeInTheDocument();
    });
    const reviews = await db.reviews.toArray();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].grade).toBe("good");
    const stored = await db.cards.toArray();
    expect(stored[0].srs.interval).toBe(1);
  });

  it("穴埋め問題に不正解だと不正解と表示され、次へボタンでAgainとして記録される", async () => {
    await seedCard({ term: "clutch", sourceMessageText: "that was such a clutch play honestly" });
    const user = userEvent.setup();

    render(<StudyPage />);

    await waitFor(() => expect(screen.getByLabelText("答えを入力")).toBeInTheDocument());
    await user.type(screen.getByLabelText("答えを入力"), "wrong-answer");
    await user.click(screen.getByRole("button", { name: "判定する" }));

    await waitFor(() => expect(screen.getByText("不正解")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "次のカードへ" }));

    await waitFor(() => {
      expect(screen.getByText(/復習セッションが終了しました/)).toBeInTheDocument();
    });
    const reviews = await db.reviews.toArray();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].grade).toBe("again");
  });

  it("意味当て4択に正解すると正誤が表示され、採点後に復習セッションが終了する", async () => {
    // termが元の発言に含まれないカードにすることで、穴埋めを出題不可にし意味当て4択に固定する
    const target = await seedCard({
      term: "GG",
      meaning: "意味A",
      sourceMessageText: "hello everyone, glad to be here today",
    });
    await seedCard({ term: "clutch", meaning: "意味B" });
    await seedCard({ term: "poggers", meaning: "意味C" });
    await seedCard({ term: "kappa", meaning: "意味D" });
    // 単語帳一覧はcreatedAtの新しい順に返るため、due値を明示的に最も早くしてGGカードの出題順を確定させる
    await db.cards.update(target.id!, { srs: { ...target.srs, due: target.srs.due - 1 } });
    const user = userEvent.setup();

    render(<StudyPage />);

    await waitFor(() => expect(screen.getByText("GG")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "意味A" }));

    await waitFor(() => expect(screen.getByText("正解!")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "簡単" }));

    // 単語帳には4件あるため、1件採点した時点ではまだ残りカードの出題に進む(セッションは終了しない)
    await waitFor(async () => {
      const reviews = await db.reviews.toArray();
      expect(reviews.filter((r) => r.grade === "easy")).toHaveLength(1);
    });
  });

  it("学習統計(復習件数・正答率)を表示する", async () => {
    await seedCard({ term: "clutch", sourceMessageText: "that was such a clutch play honestly" });
    const user = userEvent.setup();

    render(<StudyPage />);

    await waitFor(() => expect(screen.getByLabelText("答えを入力")).toBeInTheDocument());
    expect(screen.getByText(/復習件数: 0件/)).toBeInTheDocument();

    await user.type(screen.getByLabelText("答えを入力"), "clutch");
    await user.click(screen.getByRole("button", { name: "判定する" }));
    await waitFor(() => expect(screen.getByText("正解!")).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: "普通" }));

    await waitFor(() => {
      expect(screen.getByText(/復習件数: 1件/)).toBeInTheDocument();
    });
    expect(screen.getByText(/正答率: 100%/)).toBeInTheDocument();
  });

  it("採点の記録中は採点ボタンが無効化され、連打してもreviewCardは1回しか呼ばれない(二重送信防止)", async () => {
    const card = await seedCard({ term: "clutch", sourceMessageText: "that was such a clutch play honestly" });
    const user = userEvent.setup();

    let resolveReview!: (value: Awaited<ReturnType<typeof reviewsModule.reviewCard>>) => void;
    const pendingReview = new Promise<Awaited<ReturnType<typeof reviewsModule.reviewCard>>>((resolve) => {
      resolveReview = resolve;
    });
    const reviewCardSpy = vi.spyOn(reviewsModule, "reviewCard").mockReturnValue(pendingReview);

    render(<StudyPage />);
    await waitFor(() => expect(screen.getByLabelText("答えを入力")).toBeInTheDocument());
    await user.type(screen.getByLabelText("答えを入力"), "clutch");
    await user.click(screen.getByRole("button", { name: "判定する" }));
    await waitFor(() => expect(screen.getByText("正解!")).toBeInTheDocument());

    const goodButton = screen.getByRole("button", { name: "普通" });
    await user.click(goodButton);

    // reviewCardがまだ解決していない間は採点ボタンが無効化され、連打してもreviewCardは1回しか呼ばれない
    expect(goodButton).toBeDisabled();
    await user.click(goodButton);
    expect(reviewCardSpy).toHaveBeenCalledTimes(1);

    resolveReview(card);
    await waitFor(() => {
      expect(screen.getByText(/復習セッションが終了しました/)).toBeInTheDocument();
    });
  });

  it("採点の記録に失敗した場合、その旨をエラーメッセージとして表示する", async () => {
    await seedCard({ term: "clutch", sourceMessageText: "that was such a clutch play honestly" });
    const user = userEvent.setup();

    vi.spyOn(reviewsModule, "reviewCard").mockRejectedValue(new Error("カードが見つかりません(id: 1)"));

    render(<StudyPage />);
    await waitFor(() => expect(screen.getByLabelText("答えを入力")).toBeInTheDocument());
    await user.type(screen.getByLabelText("答えを入力"), "clutch");
    await user.click(screen.getByRole("button", { name: "判定する" }));
    await waitFor(() => expect(screen.getByText("正解!")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "普通" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/カードが見つかりません/);
    });
  });

  it("初期読み込みに失敗した場合、その旨をエラーメッセージとして表示する", async () => {
    vi.spyOn(cardsModule, "listCards").mockRejectedValue(new Error("単語帳の読み込みに失敗しました"));

    render(<StudyPage />);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/単語帳の読み込みに失敗しました/);
    });
  });

  it("同じ意味を持つカードが複数あっても、Reactキー重複の警告を出さずに意味当て4択を描画する", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 4件とも元の発言にtermを含めないことで、単語帳一覧の並び順に関わらずどのカードが
    // 出題対象になっても穴埋めが選ばれず、常に意味当て4択(4件とも1問に登場)になるようにする
    const sourceMessageText = "hello everyone, glad to be here today";
    await seedCard({ term: "GG", meaning: "同じ意味", sourceMessageText });
    await seedCard({ term: "clutch", meaning: "同じ意味", sourceMessageText });
    await seedCard({ term: "poggers", meaning: "違う意味C", sourceMessageText });
    await seedCard({ term: "kappa", meaning: "違う意味D", sourceMessageText });

    render(<StudyPage />);

    await waitFor(() => expect(screen.getByText("次の語句の意味は?")).toBeInTheDocument());

    const hasKeyWarning = consoleErrorSpy.mock.calls.some((args) => String(args[0]).includes("same key"));
    expect(hasKeyWarning).toBe(false);
  });
});
