/**
 * Pick up 候補の採否ゲートの比較検証(issue #123)の集計ロジック。
 *
 * 人手でラベルを付けた候補に対するゲートの判定(慣用表現として使われている確率)を入力に、
 * 次の3点を集計する純関数を提供する:
 * - ラベルごとの除去率(字義通り一致の除去率と、基本表現・学習価値ありの表現の誤除去率)
 * - ゲートの採否判定と LLM 単独の採否判定の一致度
 * - ゲート呼び出しの所要時間(1発言あたりの追加時間)の要約
 *
 * 出力に含まれるのは件数と率だけで、チャットの本文・ユーザー名は含まない。
 * 評価スクリプト(`scripts/evaluate-pickup-gate.ts`)からだけ使い、プロダクションコードからは import しない。
 */

/**
 * 候補に人手で付けるラベル。
 * - `literal`: 字義通り・偶然一致(句の境界をまたいだ一致、ステムの衝突、単なる語の並び)。ゲートが除去したい対象
 * - `basic`: 定型表現として正しく使われているが初歩的なもの
 * - `valuable`: イディオム・句動詞・スラングとして使われている、学習価値のあるもの
 */
export type GateLabel = "literal" | "basic" | "valuable";

/** 1候補分のゲートの判定 */
export interface GateJudgment {
  /** 候補の表現キー(`buildTermExpressionKey` と同じ規則) */
  expressionKey: string;
  label: GateLabel;
  /** ゲートが返した「慣用表現として使われている」確率(0〜1) */
  idiomaticProbability: number;
}

/** 1ラベル分の除去結果。`removalRate` は該当ラベルの候補が0件のとき null */
export interface GateRemoval {
  total: number;
  removed: number;
  removalRate: number | null;
}

export interface GateSummary {
  /** 採否の閾値。確率がこの値未満の候補を除去する */
  threshold: number;
  literal: GateRemoval;
  basic: GateRemoval;
  valuable: GateRemoval;
}

/** 分母が0のときは率を null にする(0除算の結果を率として見せないため) */
function rateOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

/**
 * ゲートの判定を閾値で採否に変換し、ラベルごとの除去率を集計する。
 * `literal` の除去率は高いほど良く、`basic`・`valuable` の除去率(誤除去率)は低いほど良い。
 */
export function summarizeGateJudgments(judgments: GateJudgment[], threshold: number): GateSummary {
  const summarizeLabel = (label: GateLabel): GateRemoval => {
    const targets = judgments.filter((judgment) => judgment.label === label);
    const removed = targets.filter((judgment) => judgment.idiomaticProbability < threshold).length;
    return { total: targets.length, removed, removalRate: rateOrNull(removed, targets.length) };
  };
  return {
    threshold,
    literal: summarizeLabel("literal"),
    basic: summarizeLabel("basic"),
    valuable: summarizeLabel("valuable"),
  };
}

/** 同じ候補に対する、ゲートと LLM 単独の採否判定の組 */
export interface KeepDecisionPair {
  gateKeeps: boolean;
  llmKeeps: boolean;
}

export interface AgreementSummary {
  total: number;
  bothKeep: number;
  bothDrop: number;
  onlyGateKeeps: number;
  onlyLlmKeeps: number;
  /** 採否が一致した候補の割合。比較対象が0件のとき null */
  agreementRate: number | null;
}

/** ゲートと LLM 単独の採否判定の一致度を、2×2 の内訳付きで集計する */
export function summarizeAgreement(pairs: KeepDecisionPair[]): AgreementSummary {
  const count = (gateKeeps: boolean, llmKeeps: boolean): number =>
    pairs.filter((pair) => pair.gateKeeps === gateKeeps && pair.llmKeeps === llmKeeps).length;
  const bothKeep = count(true, true);
  const bothDrop = count(false, false);
  return {
    total: pairs.length,
    bothKeep,
    bothDrop,
    onlyGateKeeps: count(true, false),
    onlyLlmKeeps: count(false, true),
    agreementRate: rateOrNull(bothKeep + bothDrop, pairs.length),
  };
}

export interface LatencySummary {
  count: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

/** 昇順に並べた値から、最近傍法でパーセンタイルを取り出す(`ratio` は 0 より大きく 1 以下) */
function nearestRankPercentile(sortedValues: number[], ratio: number): number {
  return sortedValues[Math.ceil(ratio * sortedValues.length) - 1];
}

/**
 * ゲート呼び出しの所要時間(1発言あたりの追加時間。ミリ秒)を要約する。
 * 計測値が0件のときは、要約を捏造せずエラーにする。
 */
export function summarizeLatencies(latenciesMs: number[]): LatencySummary {
  if (latenciesMs.length === 0) {
    throw new Error("計測値が0件のため、レイテンシを要約できません");
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    meanMs: total / sorted.length,
    medianMs: nearestRankPercentile(sorted, 0.5),
    p95Ms: nearestRankPercentile(sorted, 0.95),
    maxMs: sorted[sorted.length - 1],
  };
}
