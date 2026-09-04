/**
 * FSRS(Free Spaced Repetition Scheduler)による復習期日計算のラッパー(issue #113。
 * ユーザー辞書構想 #107 の Phase 3)。
 *
 * Pick upの既出管理(`store/pickup-encounters.ts`)が表現キーごとに持つ学習状態のうち、
 * 「知っている」マーク後の再表示間隔の計算を担う。Phase 2 の暫定規則(マーク回数で倍増)を
 * ts-fsrs によるFSRSアルゴリズムの復習期日計算に置き換える。
 *
 * - 学習ステップ(`learning_steps` / `relearning_steps`)は無効にする。ts-fsrs 既定の
 *   学習ステップ(1分→10分)を使うと初回マーク直後の抑制が数分になってしまうため、
 *   日単位の長期スケジュールのみ使う
 * - ファズ(復習期日のランダム化)は既定の無効のまま使い、計算を決定的に保つ
 * - カードは localStorage に保存するため、日時をエポックミリ秒に変換した
 *   数値のみのシリアライズ形式(`SrsCard`)で受け渡しする
 * - この層は完全に決定的(LLM 非依存)
 */
import { createEmptyCard, fsrs, generatorParameters, State, type Card, type Grade } from "ts-fsrs";
import { z } from "zod";

export { Rating } from "ts-fsrs";

/**
 * FSRSカードのシリアライズ形式(数値のみ)。ts-fsrs の `Card` の日時(`due` / `last_review`)を
 * エポックミリ秒に変換したもので、`store/pickup-encounters.ts` が localStorage に保存する
 */
export const srsCardSchema = z.object({
  /** 次回復習期日(エポックミリ秒)。この日時より前の再遭遇は抑制する */
  due: z.number(),
  /** 記憶の安定度(FSRS内部状態。日数換算の記憶保持期間) */
  stability: z.number(),
  /** 表現の難易度(FSRS内部状態。1〜10) */
  difficulty: z.number(),
  /** 前回復習からの経過日数(ts-fsrs v6で削除予定の互換フィールド) */
  elapsed_days: z.number(),
  /** 前回計算した復習間隔(日数) */
  scheduled_days: z.number(),
  /** 学習ステップの現在位置(学習ステップ無効のため常に0) */
  learning_steps: z.number(),
  /** 評価(復習)を適用した累計回数 */
  reps: z.number(),
  /** 忘却(Again評価)の累計回数 */
  lapses: z.number(),
  /** カードの状態(ts-fsrs の `State`: New / Learning / Review / Relearning) */
  state: z.enum(State),
  /** 最後に評価を適用した日時(エポックミリ秒)。評価済みカードでは常に設定される */
  last_review: z.number().nullable(),
});

export type SrsCard = z.infer<typeof srsCardSchema>;

/** 学習ステップ無効(日単位の長期スケジュールのみ)・ファズ無効(決定的)のスケジューラ */
const scheduler = fsrs(generatorParameters({ learning_steps: [], relearning_steps: [] }));

/** ts-fsrs の `Card`(日時が `Date`)をシリアライズ形式(数値のみ)に変換する */
function serializeCard(card: Card): SrsCard {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    last_review: card.last_review?.getTime() ?? null,
  };
}

/**
 * カードに評価を適用し、次回復習期日を計算した新しいカードを返す(引数のカードは変更しない)。
 *
 * @param card 前回までのカード。null は評価が一度も無い表現を表し、新規カードを作成して評価する
 * @param rating 評価。「知っている」マークは `Rating.Good`、忘却シグナル(マーク済み表現の
 *   意味確認)は `Rating.Again` を渡す
 * @param now 評価日時(エポックミリ秒)
 * @returns 評価を適用したカード(`due` が次回復習期日)
 */
export function reviewSrsCard(card: SrsCard | null, rating: Grade, now: number): SrsCard {
  const result = scheduler.next(card ?? createEmptyCard(now), now, rating);
  return serializeCard(result.card);
}
