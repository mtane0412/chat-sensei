/**
 * Prompt API(Gemini Nano)の利用可否を 1 か所で保持する共有ストア。
 *
 * 翻訳列(`translations.ts`)と Pick up 列(`pickups.ts`)は同じ環境で動くため、環境診断は 1 回だけ実行し、
 * その結果(`PromptApiStatus`)を両パイプラインとページで共有する。パイプラインごとに診断・保持していた
 * 以前の構成では、診断の完了タイミング差やウォームアップ失敗の片寄りで 2 列の可否状態が食い違い得た(issue #24)。
 *
 * - `ensurePromptApiDiagnosed`: 未診断なら診断を開始し、診断中なら同じ Promise を返し、確定済みならその状態を返す
 * - `markPromptApiUnavailable`: ベースセッションの生成(ウォームアップ)に失敗した場合など、
 *   診断後に判明した「使えない理由」を保持する
 * - 一度確定した状態はページ遷移で戻ってきても再診断しない(環境はページの寿命の間は変わらない前提)。
 *   Prompt API が使えない環境で暗黙にフォールバックせず、理由を保持して行ごとに「〜不可」を表示できるようにする
 */
import { create } from "zustand";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { describeDiagnosis } from "@/lib/ai/describeDiagnosis";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";

/** Prompt API の利用可否(環境診断の結果と、その後のウォームアップ失敗を反映したもの) */
export type PromptApiStatus =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "unavailable"; reason: string };

interface PromptApiState {
  status: PromptApiStatus;
}

export const usePromptApiStore = create<PromptApiState>(() => ({
  status: { status: "checking" },
}));

/** 実行中の環境診断。同時に複数のパイプラインから呼ばれても診断を 1 回にまとめるために保持する */
let inFlightDiagnosis: Promise<PromptApiStatus> | null = null;

/** 環境診断結果から、利用者に見せる「Prompt API が使えない理由」を取り出す */
function describePromptApiUnavailableReason(diagnosis: EnvironmentDiagnosis): string {
  const message = describeDiagnosis(diagnosis).find((item) => item.id === "language-model");
  return message?.message ?? "The Prompt API is not available.";
}

/**
 * Prompt API の利用可否を確定させ、その状態を返す。
 * 確定済みなら診断を再実行せずに現在の状態を返し、診断中なら実行中の診断の完了を待つ。
 * 診断そのものが失敗した場合も暗黙に ready 扱いせず、理由付きの unavailable にする。
 */
export function ensurePromptApiDiagnosed(
  diagnose: () => Promise<EnvironmentDiagnosis> = runBrowserDiagnosis,
): Promise<PromptApiStatus> {
  const current = usePromptApiStore.getState().status;
  if (current.status !== "checking") return Promise.resolve(current);
  if (inFlightDiagnosis) return inFlightDiagnosis;

  inFlightDiagnosis = diagnose()
    .then(
      (diagnosis): PromptApiStatus =>
        diagnosis.overallReady
          ? { status: "ready" }
          : { status: "unavailable", reason: describePromptApiUnavailableReason(diagnosis) },
    )
    .catch(
      (error: unknown): PromptApiStatus => ({
        status: "unavailable",
        reason: `Environment check failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
    )
    .then((status) => {
      inFlightDiagnosis = null;
      // 診断中にウォームアップ失敗などで unavailable が確定していた場合はそちらを優先する
      const settled = usePromptApiStore.getState().status;
      if (settled.status !== "checking") return settled;
      usePromptApiStore.setState({ status });
      return status;
    });
  return inFlightDiagnosis;
}

/** 診断後に判明した「Prompt API が使えない理由」(ウォームアップ失敗など)を保持する */
export function markPromptApiUnavailable(reason: string): void {
  usePromptApiStore.setState({ status: { status: "unavailable", reason } });
}

/**
 * テスト専用: ストアと実行中の診断を初期状態に戻す。各テストの afterEach で呼び出すこと。
 */
export function resetPromptApiStoreForTests(): void {
  inFlightDiagnosis = null;
  usePromptApiStore.setState({ status: { status: "checking" } });
}
