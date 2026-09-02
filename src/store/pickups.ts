/**
 * 右列「Pick up」の状態を保持するストアと、受信した発言から自動で注目の表現(語句と意味のペア)を
 * 抽出するパイプライン。
 *
 * パイプラインの流れ(診断待ちの保留・低優先度キューへの投入・結果の保持・ウォームアップ・破棄)は
 * `auto-pipeline.ts` の共通ファクトリに任せ、ここでは Pick up 固有の部分だけを定義する。
 *
 * - LLM を呼ばずに確定させる発言: 訳す文字を含まない発言(emote だけ = issue #26、Unicode 絵文字だけ、記号だけ)と
 *   `!` で始まるチャットコマンド(issue #35)は注目の表現が無いため `terms` が空の `done` にする。
 *   言語判定に回すと未判定(und)や無関係な言語で対象外になってしまうため、`pickUpExpressions` 任せにせず判定の前に確定させる
 * - ジョブ: `pickUpExpressions` を低優先度で実行し、表示中の発言者名(username / displayName)を
 *   除外名として渡す(@ 無しで本文に書かれたユーザー名を抽出結果から落とすため)
 * - セッションプール(ベースセッション)は翻訳用とは別に持つ(`structured-prompt.ts` に記載の issue #15 方針 (a))が、
 *   ジョブを流す直列キューは `auto-pipeline.ts` で翻訳列と共有する(issue #23)
 * - 発言ごとの言語判定(学ぶ言語ならその言語のセッションプールへ、解説言語と同じ・対象外ならスキップ)は
 *   `auto-pipeline.ts` が行う。ベースセッションは「学ぶ言語 1 つ × 解説言語」のペアごとに組み立てる
 * - Prompt API の利用可否は `prompt-api.ts` の共有ストアを参照する(翻訳列と共通)
 */
import { createPickupBaseSessionFactory, pickUpExpressions } from "@/lib/ai/pickup";
import type { PickupTerm } from "@/lib/ai/schemas";
import { isChatCommandMessage } from "@/lib/twitch/chat-command";
import { isTextlessMessage } from "@/lib/twitch/emotes";
import { createAutoPipeline, type AutoPipelineDeps, type PipelineEntry } from "./auto-pipeline";
import { useSettingsStore } from "./settings";
import { getStreamInfo } from "./stream-info";

/** 抽出の完了時に保持する結果。該当する表現が無い場合は `terms` が空配列 */
export interface PickupDone {
  terms: PickupTerm[];
}

/** 発言1件ぶんの抽出の状態 */
export type PickupEntry = PipelineEntry<PickupDone>;

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export type PickupPipelineDeps = AutoPipelineDeps;

const pipeline = createAutoPipeline<PickupDone>({
  // ベースセッションは設定(LLM プロバイダ)と配信の文脈(タイトル・カテゴリ。issue #54)に依存する。
  // 設定変更時・配信情報の変化時はホーム画面がパイプラインを再起動し、プールも作り直されるため、
  // 生成時点のストアの値を読めばよい
  createBaseSession: (targetLang, explainLang) =>
    createPickupBaseSessionFactory(useSettingsStore.getState().settings, targetLang, explainLang, getStreamInfo()),
  resolveWithoutModel: (message) =>
    isTextlessMessage(message.text, message.emotes) || isChatCommandMessage(message.text) ? { terms: [] } : null,
  runJob: (pool, message, { signal, getMessages }) =>
    pickUpExpressions(pool, message.text, {
      priority: "low",
      signal,
      emotes: message.emotes,
      excludedNames: getMessages().flatMap((item) => [item.username, item.displayName]),
    }),
});

export const usePickupStore = pipeline.useStore;

/** Pick up パイプラインを開始する。戻り値の関数で停止する。ホーム画面のマウント時に1回呼び出す想定 */
export const startPickupPipeline = pipeline.start;

/**
 * Pick up 用ベースセッションを先に生成する。「接続する」クリックなどユーザー操作の
 * ハンドラから呼ぶこと(モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要)。
 */
export const warmUpPickupPipeline = pipeline.warmUp;

/** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
export const resetPickupStoreForTests = pipeline.resetForTests;
