/**
 * Pick up 候補生成の実チャット評価(issue #117)の集計ロジック。
 *
 * 1発言ごとの候補(表現リストに一致した表現キーの配列)を入力に、次の4点を集計する純関数を提供する:
 * - 1発言あたりの候補件数の分布(注入件数の上限を決める根拠)
 * - 注入上限ごとの「候補が上限を超えて切り捨てが発生する発言数」
 * - 頻出表現の上位(過剰マッチしている表現の発見用)
 * - 既出管理のクールダウンのシミュレーション(クールダウン既定値の妥当性の確認用)
 *
 * 出力に含まれる文字列は表現リスト由来の表現キーだけで、チャットの本文・ユーザー名は含まない。
 * 評価スクリプト(`scripts/evaluate-pickup-candidates.ts`)からだけ使い、プロダクションコードからは import しない。
 */

/** 1発言分の観測データ */
export interface CandidateObservation {
  /** 発言の時刻(ミリ秒のUNIXタイムスタンプ) */
  timestampMs: number;
  /** その発言で表現リストに一致した候補の表現キー(`buildTermExpressionKey` と同じ規則) */
  expressionKeys: string[];
}

export interface CandidateStatsOptions {
  /** 比較する注入件数の上限の候補(例: 8〜12) */
  injectionLimits: number[];
  /** シミュレーションするクールダウン(ミリ秒) */
  cooldownMs: number;
  /** 頻出表現を上位何件まで返すか */
  topExpressionCount: number;
}

export interface CandidateStats {
  messageCount: number;
  /** 候補が1件以上あった発言数 */
  messagesWithCandidates: number;
  totalCandidateCount: number;
  maxCandidateCount: number;
  /** 1発言あたりの候補件数の分布。`candidateCount` の昇順 */
  candidateCountDistribution: { candidateCount: number; messageCount: number }[];
  /** 注入上限ごとの、候補件数が上限を超える発言数。`injectionLimits` の指定順 */
  overInjectionLimit: { limit: number; messageCount: number }[];
  /** 一致した表現キーの種類数 */
  distinctExpressionCount: number;
  /** 出現回数の降順(同数は表現キーの昇順)の上位 `topExpressionCount` 件 */
  topExpressions: { expressionKey: string; occurrences: number }[];
  /**
   * クールダウンのシミュレーション結果。全候補が LLM に採用されて表示されると仮定した上限値で、
   * 実際の表示回数はこれ以下になる。
   * - `shownCount`: 表示される出現数(初回表示 + 再表示)
   * - `suppressedCount`: 最終表示からクールダウン内のため抑制される出現数
   * - `reshownCount`: クールダウンを過ぎて再表示される出現数(`shownCount` の内数)
   */
  cooldown: { shownCount: number; suppressedCount: number; reshownCount: number };
}

/**
 * クールダウンをシミュレーションする。判定規則は `store/pickup-encounters.ts` の既出管理と同じで、
 * 抑制された出現は最終表示日時を更新しない(FSRSカードによる抑制は対象外)。
 *
 * @param observations 時刻の昇順に並んだ観測データ
 */
function simulateCooldown(observations: CandidateObservation[], cooldownMs: number): CandidateStats["cooldown"] {
  const lastShownAtByKey = new Map<string, number>();
  const result = { shownCount: 0, suppressedCount: 0, reshownCount: 0 };
  for (const { timestampMs, expressionKeys } of observations) {
    for (const key of expressionKeys) {
      const lastShownAt = lastShownAtByKey.get(key);
      if (lastShownAt !== undefined && timestampMs - lastShownAt < cooldownMs) {
        result.suppressedCount += 1;
        continue;
      }
      if (lastShownAt !== undefined) result.reshownCount += 1;
      result.shownCount += 1;
      lastShownAtByKey.set(key, timestampMs);
    }
  }
  return result;
}

/**
 * 観測データを集計する。
 *
 * @param observations 1発言ごとの観測データ。時刻順でなくてもよい(内部で昇順に並べ直す)
 */
export function summarizeCandidateObservations(
  observations: CandidateObservation[],
  options: CandidateStatsOptions,
): CandidateStats {
  const messageCountByCandidateCount = new Map<number, number>();
  const occurrencesByKey = new Map<string, number>();
  for (const { expressionKeys } of observations) {
    const candidateCount = expressionKeys.length;
    messageCountByCandidateCount.set(candidateCount, (messageCountByCandidateCount.get(candidateCount) ?? 0) + 1);
    for (const key of expressionKeys) {
      occurrencesByKey.set(key, (occurrencesByKey.get(key) ?? 0) + 1);
    }
  }

  const candidateCountDistribution = [...messageCountByCandidateCount]
    .map(([candidateCount, messageCount]) => ({ candidateCount, messageCount }))
    .sort((a, b) => a.candidateCount - b.candidateCount);

  const topExpressions = [...occurrencesByKey]
    .map(([expressionKey, occurrences]) => ({ expressionKey, occurrences }))
    .sort((a, b) => b.occurrences - a.occurrences || a.expressionKey.localeCompare(b.expressionKey))
    .slice(0, options.topExpressionCount);

  const chronological = [...observations].sort((a, b) => a.timestampMs - b.timestampMs);

  return {
    messageCount: observations.length,
    messagesWithCandidates: observations.filter(({ expressionKeys }) => expressionKeys.length > 0).length,
    totalCandidateCount: observations.reduce((total, { expressionKeys }) => total + expressionKeys.length, 0),
    maxCandidateCount: candidateCountDistribution.at(-1)?.candidateCount ?? 0,
    candidateCountDistribution,
    overInjectionLimit: options.injectionLimits.map((limit) => ({
      limit,
      messageCount: observations.filter(({ expressionKeys }) => expressionKeys.length > limit).length,
    })),
    distinctExpressionCount: occurrencesByKey.size,
    topExpressions,
    cooldown: simulateCooldown(chronological, options.cooldownMs),
  };
}
