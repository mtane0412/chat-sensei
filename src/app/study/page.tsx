/**
 * 復習クイズページ(/study)。
 *
 * SM-2(間隔反復)で期日が来たカードだけを出題する。出題形式は「意味当て4択」と
 * 「穴埋め」の2種で、回答後は正誤を表示したうえで採点(Again/Hard/Good/Easy)を行う。
 * 採点結果は `reviewCard` がSM-2状態の更新とreviews履歴の記録を行い、次回の
 * 出題間隔に反映される。クイズの根幹はコードだけで完結し、LLMには依存しない
 * (AIが使えない環境でも復習は動作するという設計方針、AGENTS.md参照)。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { listCards, selectDueCards } from "@/lib/db/cards";
import { getReviewStats, reviewCard } from "@/lib/db/reviews";
import type { Card as DeckCard } from "@/lib/db/schema";
import type { Grade } from "@/lib/db/srs";
import { buildQuizQuestion, isQuizzable, type QuizQuestion } from "@/lib/study/quiz";

type Phase = "loading" | "no-due" | "answering" | "answered" | "finished";

/** 学習統計の表示用に、件数ベースで正答率を管理する(採点のたびにDBへ再集計をかけずに済ませるため) */
interface ReviewCounts {
  total: number;
  /** Again以外の採点を正答とみなした件数 */
  correct: number;
}

const INITIAL_REVIEW_COUNTS: ReviewCounts = { total: 0, correct: 0 };

/** エラーをユーザー向けメッセージに変換する(想定外の例外でも空文字を表示しないための最終防御) */
function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export default function StudyPage() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [deck, setDeck] = useState<DeckCard[]>([]);
  const [queue, setQueue] = useState<DeckCard[]>([]);
  const [question, setQuestion] = useState<QuizQuestion | null>(null);
  const [isCorrect, setIsCorrect] = useState<boolean | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [reviewCounts, setReviewCounts] = useState<ReviewCounts>(INITIAL_REVIEW_COUNTS);
  const [isSubmittingGrade, setIsSubmittingGrade] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    const now = Date.now();
    Promise.all([listCards(), getReviewStats()])
      .then(([allCards, initialStats]) => {
        const due = selectDueCards(allCards, now);
        // 意味当て4択・穴埋めのどちらも出題できないカード(単語帳が1件だけ、かつtermが元発言と一致しない等)は除外する
        const quizzable = due.filter((card) => isQuizzable(card, allCards));

        setDeck(allCards);
        setReviewCounts({
          total: initialStats.totalReviews,
          correct: Math.round(initialStats.correctRate * initialStats.totalReviews),
        });

        if (quizzable.length === 0) {
          setPhase("no-due");
          return;
        }

        setQueue(quizzable);
        setQuestion(buildQuizQuestion(quizzable[0], allCards));
        setPhase("answering");
      })
      .catch((error: unknown) => {
        setErrorMessage(toErrorMessage(error, "復習データの読み込みに失敗しました"));
      });
  }, []);

  const handleMeaningChoiceAnswer = useCallback(
    (choiceIndex: number) => {
      if (!question || question.format !== "meaning-choice") return;
      setIsCorrect(choiceIndex === question.correctIndex);
      setPhase("answered");
    },
    [question],
  );

  const handleFillBlankSubmit = useCallback(() => {
    if (!question || question.format !== "fill-blank") return;
    const normalizedInput = inputValue.trim().toLowerCase();
    const normalizedTerm = question.card.term.trim().toLowerCase();
    setIsCorrect(normalizedInput === normalizedTerm);
    setPhase("answered");
  }, [question, inputValue]);

  const handleGrade = useCallback(
    (grade: Grade) => {
      // 記録が完了する前の連打で同じ回答が二重に採点されるのを防ぐ
      if (!question?.card.id || isSubmittingGrade) return;
      const cardId = question.card.id;

      setIsSubmittingGrade(true);
      reviewCard(cardId, grade, Date.now())
        .then(() => {
          setReviewCounts((prev) => ({
            total: prev.total + 1,
            correct: prev.correct + (grade === "again" ? 0 : 1),
          }));

          const rest = queue.slice(1);
          setIsCorrect(null);
          setInputValue("");

          if (rest.length === 0) {
            setQueue([]);
            setQuestion(null);
            setPhase("finished");
            return;
          }

          setQueue(rest);
          setQuestion(buildQuizQuestion(rest[0], deck));
          setPhase("answering");
        })
        .catch((error: unknown) => {
          setErrorMessage(toErrorMessage(error, "採点の記録に失敗しました"));
        })
        .finally(() => {
          setIsSubmittingGrade(false);
        });
    },
    [question, queue, deck, isSubmittingGrade],
  );

  const correctRate = reviewCounts.total === 0 ? 0 : reviewCounts.correct / reviewCounts.total;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>復習クイズ</CardTitle>
          <CardDescription>
            復習件数: {reviewCounts.total}件 / 正答率: {Math.round(correctRate * 100)}%
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          {phase === "loading" && !errorMessage && <p className="text-sm text-muted-foreground">読み込み中...</p>}

          {phase === "no-due" && (
            <p className="text-sm text-muted-foreground">
              復習するカードはありません。単語帳にカードを追加するか、期日が来るまでお待ちください。
            </p>
          )}

          {phase === "finished" && (
            <p className="text-sm text-muted-foreground">復習セッションが終了しました。お疲れさまでした。</p>
          )}

          {(phase === "answering" || phase === "answered") && question && (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">残り{queue.length}件</p>

              {question.format === "meaning-choice" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">次の語句の意味は?</p>
                  <p className="text-lg font-semibold">{question.card.term}</p>
                  <p className="text-xs italic text-muted-foreground">「{question.card.sourceMessageText}」</p>
                  <div className="grid gap-2">
                    {question.choices.map((choice, index) => (
                      <Button
                        key={index}
                        variant="outline"
                        disabled={phase === "answered"}
                        onClick={() => handleMeaningChoiceAnswer(index)}
                      >
                        {choice}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {question.format === "fill-blank" && (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">空欄に入る語句は?</p>
                  <p className="text-lg font-semibold">{question.maskedText}</p>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="fill-blank-input">答えを入力</Label>
                    <div className="flex gap-2">
                      <Input
                        id="fill-blank-input"
                        value={inputValue}
                        disabled={phase === "answered"}
                        onChange={(e) => setInputValue(e.target.value)}
                      />
                      <Button onClick={handleFillBlankSubmit} disabled={phase === "answered"}>
                        判定する
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {phase === "answered" && (
                <div className="flex flex-col gap-2 rounded-md border p-3">
                  <p className="font-semibold">{isCorrect ? "正解!" : "不正解"}</p>
                  <p className="text-sm text-muted-foreground">{question.card.meaning}</p>
                  {question.card.note && <p className="text-xs text-muted-foreground">{question.card.note}</p>}

                  {isCorrect ? (
                    <div className="flex gap-2">
                      <Button variant="outline" disabled={isSubmittingGrade} onClick={() => handleGrade("hard")}>
                        難しい
                      </Button>
                      <Button variant="outline" disabled={isSubmittingGrade} onClick={() => handleGrade("good")}>
                        普通
                      </Button>
                      <Button variant="outline" disabled={isSubmittingGrade} onClick={() => handleGrade("easy")}>
                        簡単
                      </Button>
                    </div>
                  ) : (
                    <Button variant="outline" disabled={isSubmittingGrade} onClick={() => handleGrade("again")}>
                      次のカードへ
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
