/**
 * src/lib/study/quiz.ts のテスト。
 *
 * DBアクセスなしの純関数として、意味当て4択・穴埋めの2形式の出題ロジックを検証する。
 * 選択肢のシャッフルは乱数を注入できるようにしているため、テストでは決定的な乱数関数を渡す。
 */
import { describe, expect, it } from "vitest";
import {
  buildFillBlankQuestion,
  buildMeaningChoiceQuestion,
  buildQuizQuestion,
  isFillBlankAvailable,
  isMeaningChoiceAvailable,
  isQuizzable,
} from "./quiz";
import type { Card } from "@/lib/db/schema";

let nextCardId = 1;

/** 単語帳カードを模したテストデータ(意味の分かる日本語・実チャット文を使用) */
function buildCard(overrides: Partial<Card> = {}): Card {
  return {
    id: nextCardId++,
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
    createdAt: 0,
    srs: { due: 0, interval: 0, easeFactor: 2.5, repetitions: 0, lapses: 0, lastReviewedAt: null },
    ...overrides,
  };
}

describe("buildMeaningChoiceQuestion", () => {
  it("他カードが3件以上あれば、正解1件+誤答3件の4択を作る", () => {
    const target = buildCard({ term: "GG", meaning: "意味A" });
    const others = [
      buildCard({ term: "clutch", meaning: "意味B" }),
      buildCard({ term: "poggers", meaning: "意味C" }),
      buildCard({ term: "kappa", meaning: "意味D" }),
    ];

    const question = buildMeaningChoiceQuestion(target, others, () => 0);

    expect(question.choices).toHaveLength(4);
    expect(question.choices).toContain("意味A");
    expect(question.choices[question.correctIndex]).toBe("意味A");
  });

  it("他カードが3件未満の場合はエラーを投げる", () => {
    const target = buildCard();
    const others = [buildCard({ term: "clutch" }), buildCard({ term: "poggers" })];

    expect(() => buildMeaningChoiceQuestion(target, others)).toThrow(/3件以上/);
  });

  it("同じ乱数関数を渡せば常に同じ並びになり(決定的)、異なる乱数関数なら並びが変わりうる", () => {
    const target = buildCard({ term: "GG", meaning: "意味A" });
    const others = [
      buildCard({ term: "clutch", meaning: "意味B" }),
      buildCard({ term: "poggers", meaning: "意味C" }),
      buildCard({ term: "kappa", meaning: "意味D" }),
    ];

    const first = buildMeaningChoiceQuestion(target, others, () => 0);
    const second = buildMeaningChoiceQuestion(target, others, () => 0);
    const third = buildMeaningChoiceQuestion(target, others, () => 0.99);

    expect(first.choices).toEqual(second.choices);
    expect(first.choices).not.toEqual(third.choices);
    expect(first.choices[first.correctIndex]).toBe("意味A");
    expect(third.choices[third.correctIndex]).toBe("意味A");
  });
});

describe("buildFillBlankQuestion", () => {
  it("元の発言からtermをマスクした穴埋め問題を作る", () => {
    const card = buildCard({ term: "clutch", sourceMessageText: "that was such a clutch play honestly" });

    const question = buildFillBlankQuestion(card);

    expect(question.maskedText).toBe("that was such a ＿＿＿＿ play honestly");
  });

  it("元の発言にtermが複数回登場する場合はすべてマスクする", () => {
    const card = buildCard({ term: "gg", sourceMessageText: "gg gg well played" });

    const question = buildFillBlankQuestion(card);

    expect(question.maskedText).toBe("＿＿＿＿ ＿＿＿＿ well played");
  });

  it("元の発言にtermが含まれない場合はエラーを投げる", () => {
    const card = buildCard({ term: "clutch", sourceMessageText: "gg well played" });

    expect(() => buildFillBlankQuestion(card)).toThrow(/含まれていません/);
  });

  it("termが他の単語の一部として埋め込まれている箇所はマスクしない(単語境界チェック)", () => {
    // "goggles" の中の "gg" は独立した語ではないため、単独で登場する "gg" だけをマスクする
    const card = buildCard({ term: "gg", sourceMessageText: "gg goggles everywhere" });

    const question = buildFillBlankQuestion(card);

    expect(question.maskedText).toBe("＿＿＿＿ goggles everywhere");
  });
});

describe("isMeaningChoiceAvailable", () => {
  it("自分自身を除いた他カードが3件以上あればtrueを返す", () => {
    const target = buildCard();
    const deck = [target, buildCard(), buildCard(), buildCard()];

    expect(isMeaningChoiceAvailable(target, deck)).toBe(true);
  });

  it("自分自身を除いた他カードが3件未満ならfalseを返す", () => {
    const target = buildCard();
    const deck = [target, buildCard()];

    expect(isMeaningChoiceAvailable(target, deck)).toBe(false);
  });
});

describe("isFillBlankAvailable", () => {
  it("元の発言にtermが含まれていればtrueを返す", () => {
    const card = buildCard({ term: "clutch", sourceMessageText: "that was clutch" });

    expect(isFillBlankAvailable(card)).toBe(true);
  });

  it("元の発言にtermが含まれていなければfalseを返す", () => {
    const card = buildCard({ term: "clutch", sourceMessageText: "gg well played" });

    expect(isFillBlankAvailable(card)).toBe(false);
  });

  it("termが他の単語の一部として埋め込まれているだけの場合はfalseを返す(単語境界チェック)", () => {
    const card = buildCard({ term: "gg", sourceMessageText: "goggles everywhere" });

    expect(isFillBlankAvailable(card)).toBe(false);
  });
});

describe("isQuizzable", () => {
  it("意味当て4択・穴埋めのどちらかが出題可能ならtrueを返す", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "that was such a clutch play" });

    expect(isQuizzable(target, [target])).toBe(true);
  });

  it("どちらの形式も出題できない場合はfalseを返す", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "gg well played" });

    expect(isQuizzable(target, [target])).toBe(false);
  });
});

describe("buildQuizQuestion", () => {
  it("両方の形式が出題可能な場合、乱数が0.5未満なら意味当て4択になる", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "that was such a clutch play" });
    const deck = [target, buildCard(), buildCard(), buildCard()];

    const question = buildQuizQuestion(target, deck, () => 0.1);

    expect(question.format).toBe("meaning-choice");
  });

  it("両方の形式が出題可能な場合、乱数が0.5以上なら穴埋めになる", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "that was such a clutch play" });
    const deck = [target, buildCard(), buildCard(), buildCard()];

    const question = buildQuizQuestion(target, deck, () => 0.9);

    expect(question.format).toBe("fill-blank");
  });

  it("意味当て4択が出題できない場合(他カードが3件未満)は穴埋めになる", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "that was such a clutch play" });
    const deck = [target];

    const question = buildQuizQuestion(target, deck);

    expect(question.format).toBe("fill-blank");
  });

  it("どちらの形式も出題できない場合はエラーを投げる", () => {
    const target = buildCard({ term: "clutch", sourceMessageText: "gg well played" });
    const deck = [target];

    expect(() => buildQuizQuestion(target, deck)).toThrow(/出題可能/);
  });
});
