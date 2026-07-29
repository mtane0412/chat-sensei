/**
 * 復習クイズ(/study)の出題ロジックを純関数として実装するモジュール。
 *
 * 出題形式は2種類:
 * - 意味当て4択: 対象カードの意味を正解とし、誤答選択肢を単語帳の他カードから抽出する
 * - 穴埋め: 対象カードの元のチャット原文(sourceMessageText)からtermをマスクする
 *
 * DBアクセスは行わず、呼び出し元(/study ページ)がDexieから読み込んだカード配列を渡す。
 * 選択肢のシャッフルに使う乱数は引数として注入できるようにし、テストで決定的に検証できる
 * ようにしている(既定値は `Math.random`)。
 */
import type { Card } from "@/lib/db/schema";

/** 意味当て4択を出題するために必要な、対象カード以外の最小カード枚数(誤答選択肢の数) */
export const MIN_DISTRACTOR_COUNT = 3;

/** 穴埋め問題でtermを隠す際のプレースホルダー */
const BLANK_PLACEHOLDER = "＿＿＿＿";

/** 正規表現の特殊文字をエスケープする(termをそのままリテラルとして扱うため) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * termの前後が文字・数字で挟まれていない箇所だけにマッチする正規表現を組み立てる。
 * 例えば term="gg" は "goggles" の内部にマッチせず、独立した "gg" にのみマッチする。
 * (Unicodeの文字カテゴリを使うため、日本語など多言語のtermにも対応する)
 */
function buildWordBoundaryPattern(term: string, flags: string): RegExp {
  const escaped = escapeRegExp(term);
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, `${flags}u`);
}

export interface MeaningChoiceQuestion {
  format: "meaning-choice";
  card: Card;
  /** シャッフル済みの選択肢(意味の文字列)。1件だけが正解 */
  choices: string[];
  /** `choices` 内で正解が入っているインデックス */
  correctIndex: number;
}

export interface FillBlankQuestion {
  format: "fill-blank";
  card: Card;
  /** sourceMessageText 中のtermをすべて `BLANK_PLACEHOLDER` に置き換えた文字列 */
  maskedText: string;
}

export type QuizQuestion = MeaningChoiceQuestion | FillBlankQuestion;

/** Fisher-Yatesで配列をシャッフルする(引数の配列は変更しない) */
function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 対象カードについて、意味当て4択が出題可能か(誤答選択肢を3件確保できるか)を判定する */
export function isMeaningChoiceAvailable(card: Card, deck: Card[]): boolean {
  return deck.filter((other) => other.id !== card.id).length >= MIN_DISTRACTOR_COUNT;
}

/**
 * 対象カードについて、穴埋めが出題可能か(元の発言にtermが単語境界つきで含まれるか)を判定する。
 * 単純な部分一致(includes)だと、他の単語に埋め込まれた箇所(例: term="gg"に対する"goggles")を
 * 誤ってマッチさせてしまうため、前後が文字・数字でない箇所への一致のみを対象とする。
 */
export function isFillBlankAvailable(card: Card): boolean {
  return buildWordBoundaryPattern(card.term, "").test(card.sourceMessageText);
}

/** 対象カードについて、意味当て4択・穴埋めのいずれかが出題可能かを判定する */
export function isQuizzable(card: Card, deck: Card[]): boolean {
  return isMeaningChoiceAvailable(card, deck) || isFillBlankAvailable(card);
}

/**
 * 意味当て4択を作る。誤答選択肢は `otherCards` からランダムに3件抽出する。
 * `otherCards` が3件未満の場合は誤答が確保できないためエラーを投げる
 * (呼び出し元は `isMeaningChoiceAvailable` で事前に確認すること)。
 */
export function buildMeaningChoiceQuestion(
  card: Card,
  otherCards: Card[],
  random: () => number = Math.random,
): MeaningChoiceQuestion {
  if (otherCards.length < MIN_DISTRACTOR_COUNT) {
    throw new Error(
      `意味当て4択には誤答選択肢として他のカードが${MIN_DISTRACTOR_COUNT}件以上必要です(現在: ${otherCards.length}件)`,
    );
  }

  const distractors = shuffle(otherCards, random).slice(0, MIN_DISTRACTOR_COUNT);
  const options = [
    { text: card.meaning, isCorrect: true },
    ...distractors.map((distractor) => ({ text: distractor.meaning, isCorrect: false })),
  ];
  const shuffledOptions = shuffle(options, random);

  return {
    format: "meaning-choice",
    card,
    choices: shuffledOptions.map((option) => option.text),
    correctIndex: shuffledOptions.findIndex((option) => option.isCorrect),
  };
}

/**
 * 穴埋め問題を作る。元の発言(sourceMessageText)にtermが含まれない場合はエラーを投げる
 * (呼び出し元は `isFillBlankAvailable` で事前に確認すること)。
 */
export function buildFillBlankQuestion(card: Card): FillBlankQuestion {
  if (!isFillBlankAvailable(card)) {
    throw new Error(`元の発言にtermが含まれていません(term: ${card.term}, 発言: ${card.sourceMessageText})`);
  }

  return {
    format: "fill-blank",
    card,
    maskedText: card.sourceMessageText.replace(buildWordBoundaryPattern(card.term, "g"), BLANK_PLACEHOLDER),
  };
}

/**
 * カードとデッキ(単語帳全体)の状況に応じて、意味当て4択・穴埋めのいずれかを出題する。
 * 両方出題可能な場合は乱数で形式を選ぶ。どちらも出題できない場合はエラーを投げる。
 */
export function buildQuizQuestion(card: Card, deck: Card[], random: () => number = Math.random): QuizQuestion {
  if (!isQuizzable(card, deck)) {
    throw new Error(`出題可能な形式がありません(term: ${card.term})`);
  }

  const canMeaningChoice = isMeaningChoiceAvailable(card, deck);
  const canFillBlank = isFillBlankAvailable(card);

  const useMeaningChoice = canMeaningChoice && (!canFillBlank || random() < 0.5);
  if (useMeaningChoice) {
    const otherCards = deck.filter((other) => other.id !== card.id);
    return buildMeaningChoiceQuestion(card, otherCards, random);
  }
  return buildFillBlankQuestion(card);
}
