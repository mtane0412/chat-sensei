/**
 * SM-2相当の間隔反復アルゴリズムを純関数として実装するモジュール。
 *
 * 復習クイズ(/study)の採点結果からカードの次回復習期日を計算する。
 * 安定性を優先し、DBアクセスもLLM呼び出しも行わない(`gradeCard` は入力から出力を
 * 決定的に計算するだけの純関数)。
 *
 * 採点は Anki などで広く使われる4段階(Again/Hard/Good/Easy)とし、教科書的な
 * SuperMemo-2 の定義に合わせて「今回のintervalは更新前のeaseFactorを使って計算し、
 * easeFactor自体はこの回の採点結果で更新して次回に持ち越す」という順序で計算する。
 */
import type { CardSrsState } from "./schema";

/** 復習クイズの採点(自己申告する想起の手応え) */
export const GRADES = ["again", "hard", "good", "easy"] as const;
export type Grade = (typeof GRADES)[number];

/** easeFactorがどれだけ下がっても学習が破綻しないための下限値(SuperMemo-2の定義値) */
const MIN_EASE_FACTOR = 1.3;

/** 採点ごとのeaseFactor増減幅 */
const EASE_FACTOR_DELTA: Record<Grade, number> = {
  again: -0.2,
  hard: -0.15,
  good: 0,
  easy: 0.15,
};

/** 初回成功時(repetitions === 0)の次回間隔(日) */
const FIRST_INTERVAL_DAYS: Record<Exclude<Grade, "again">, number> = {
  hard: 1,
  good: 1,
  easy: 4,
};

/** 2回目成功時(repetitions === 1)の次回間隔(日) */
const SECOND_INTERVAL_DAYS: Record<Exclude<Grade, "again">, number> = {
  hard: 3,
  good: 6,
  easy: 10,
};

/** 3回目以降のHardで、easeFactorに依存せずintervalに掛ける係数 */
const HARD_INTERVAL_MULTIPLIER = 1.2;

/** 3回目以降のEasyで、easeFactorベースのintervalにさらに掛けるボーナス係数 */
const EASY_BONUS_MULTIPLIER = 1.3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 採点結果(grade)をもとに、現在のSRS状態から次回のSRS状態を計算する。
 *
 * - Again: 学習に失敗したとみなし、repetitions/intervalを0にリセットして即座に再出題対象にする
 * - Hard/Good/Easy: repetitionsを進め、直近の復習回数(0回目・1回目・2回目以降)に応じた式でintervalを伸ばす
 *
 * @param srsState 現在のSRS状態
 * @param grade 復習クイズでの採点
 * @param now 採点時刻(epoch ms)。呼び出し元で確定させた時刻を渡す(この関数はDate.now()を呼ばない)
 */
export function gradeCard(srsState: CardSrsState, grade: Grade, now: number): CardSrsState {
  const easeFactor = Math.max(MIN_EASE_FACTOR, srsState.easeFactor + EASE_FACTOR_DELTA[grade]);

  if (grade === "again") {
    return {
      due: now,
      interval: 0,
      easeFactor,
      repetitions: 0,
      lapses: srsState.lapses + 1,
      lastReviewedAt: now,
    };
  }

  const repetitions = srsState.repetitions + 1;
  let interval: number;
  if (srsState.repetitions === 0) {
    interval = FIRST_INTERVAL_DAYS[grade];
  } else if (srsState.repetitions === 1) {
    interval = SECOND_INTERVAL_DAYS[grade];
  } else if (grade === "hard") {
    interval = srsState.interval * HARD_INTERVAL_MULTIPLIER;
  } else if (grade === "easy") {
    interval = srsState.interval * srsState.easeFactor * EASY_BONUS_MULTIPLIER;
  } else {
    interval = srsState.interval * srsState.easeFactor;
  }
  interval = Math.max(1, Math.round(interval));

  return {
    due: now + interval * DAY_MS,
    interval,
    easeFactor,
    repetitions,
    lapses: srsState.lapses,
    lastReviewedAt: now,
  };
}
