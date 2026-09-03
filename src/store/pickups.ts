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
 * - 発言ごとの言語判定(学ぶ言語なら順方向、解説言語と同じなら逆方向、どちらでもなければスキップ)は
 *   `auto-pipeline.ts` が行う。ベースセッションは「学ぶ言語 × 解説言語」のペアから組み立てる
 * - 逆方向(解説言語の発言): 訳文を自前で生成せず、翻訳パイプライン(`translations.ts`)が生成した
 *   学ぶ言語の訳文(翻訳列に表示されるもの)を待って再利用し、その訳文に対して順方向と同じ抽出を行う
 *   (issue #68。訳文の二重生成と、照合対象と表示訳文の不整合を防ぐ)。抽出結果からは、機械翻訳の
 *   誤訳・幻覚に由来しやすい固有名詞的な語句を `filterTranslationArtifactTerms` で決定的に落とす
 * - 順方向・逆方向とも、抽出結果からは普通の単語・字義通りの句(`filterOrdinaryTerms`。issue #95)、
 *   疑問文まるごとの抽出(`filterQuestionSentenceTerms`。issue #100)、意味テキストに解説言語で
 *   使わない文字種が混ざった語句(`filterForeignScriptMeaningTerms`。issue #98)を決定的に落とす。
 *   順方向では文中に固有名詞的な語を含む句(`filterProperNounPhraseTerms`。issue #100)も落とす
 * - Prompt API の利用可否は `prompt-api.ts` の共有ストアを参照する(翻訳列と共通)
 */
import { createPickupBaseSessionFactory, pickUpExpressions } from "@/lib/ai/pickup";
import {
  filterForeignScriptMeaningTerms,
  filterProperNounPhraseTerms,
  filterQuestionSentenceTerms,
  filterTranslationArtifactTerms,
} from "@/lib/ai/pickup-filter";
import { filterOrdinaryTerms } from "@/lib/ai/pickup-ordinary-filter";
import { LowPriorityQueueOverflowError } from "@/lib/ai/session-pool";
import type { MessageSegment } from "@/lib/twitch/emotes";
import type { PickupTerm } from "@/lib/ai/schemas";
import { isChatCommandMessage } from "@/lib/twitch/chat-command";
import { isTextlessMessage } from "@/lib/twitch/emotes";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import {
  createAutoPipeline,
  type AutoPipelineDeps,
  type AutoPipelineJobContext,
  type PipelineEntry,
} from "./auto-pipeline";
import { useSettingsStore } from "./settings";
import { getStreamInfo } from "./stream-info";
import { useTranslationStore } from "./translations";

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
  // 逆方向は翻訳パイプラインが生成した学ぶ言語の訳文に対して抽出するため、
  // 入力・出力の言語関係は順方向(学ぶ言語の本文 → 解説言語の意味)と同じでよく、同じプロンプトを使う
  createReverseBaseSession: (learningLang, explainLang) =>
    createPickupBaseSessionFactory(useSettingsStore.getState().settings, learningLang, explainLang, getStreamInfo()),
  resolveWithoutModel: (message) =>
    isTextlessMessage(message.text, message.emotes) || isChatCommandMessage(message.text) ? { terms: [] } : null,
  // 抽出結果からは、文中に固有名詞を含む句と疑問文まるごとの抽出を落とし(issue #100)、
  // 普通の単語・字義通りの句を高頻度語リスト・表現リストで決定的に落とし(issue #95)、
  // 意味テキストに解説言語で使わない文字種が混ざった語句も落とす(issue #98)。
  // 言語設定はベースセッション生成時(createBaseSession)と同じく生成時点のストアの値を読めばよい
  runJob: async (pool, message, context) => {
    const result = await pickUpExpressions(pool, message.text, buildPickupJobOptions(message, context));
    const { learningLang, explainLang } = useSettingsStore.getState().settings;
    const terms = filterQuestionSentenceTerms(filterProperNounPhraseTerms(result.terms, learningLang));
    return {
      terms: filterForeignScriptMeaningTerms(filterOrdinaryTerms(terms, learningLang), explainLang, learningLang),
    };
  },
  // 逆方向: 翻訳パイプラインの訳文(翻訳列に表示されるもの)を待って再利用し、訳文を二重生成しない(issue #68)。
  // 訳文は emote 復元済みのセグメント列なので、emote を空白に置き換えた本文に対して順方向と同じ抽出を行う
  runReverseJob: async (pool, message, context) => {
    if (message.id === null) {
      // 共通ファクトリは ID の無い発言を投入しないため到達しない想定。暗黙に処理せず失敗させる(Fail-Fast)
      throw new Error("ID の無い発言は逆方向 Pick up の対象にできません");
    }
    const segments = await waitForReverseTranslation(message.id, context.signal);
    const translationText = segments.map((segment) => (segment.type === "text" ? segment.text : " ")).join("");
    // 訳文は emote を空白化済みのため emotes は渡さない(順方向と異なり emote の位置情報も存在しない)
    const result = await pickUpExpressions(pool, translationText, {
      priority: "low",
      signal: context.signal,
      excludedNames: collectExcludedNames(context),
    });
    // 訳文は機械翻訳のため、誤訳・幻覚に由来する固有名詞的な語句を決定的に落とし(issue #94)、
    // 疑問文まるごとの抽出(issue #100)、普通の単語・字義通りの句(issue #95)、意味テキストに
    // 解説言語で使わない文字種が混ざった語句(issue #98)も落とす。順方向の固有名詞フィルタ
    // (filterProperNounPhraseTerms)は issue #94 のより厳しい判定に包含されるため適用しない。
    // 言語設定はベースセッション生成時(createReverseBaseSession)と同じく生成時点のストアの値を読めばよい
    const { learningLang, explainLang } = useSettingsStore.getState().settings;
    const terms = filterQuestionSentenceTerms(filterTranslationArtifactTerms(result.terms, learningLang));
    return {
      terms: filterForeignScriptMeaningTerms(filterOrdinaryTerms(terms, learningLang), explainLang, learningLang),
    };
  },
});

/**
 * 翻訳パイプラインの逆方向訳文(学ぶ言語)が確定するのを待つ。
 * - `done`: 訳文のセグメント列を返す
 * - `dropped`: `LowPriorityQueueOverflowError` を投げ、Pick up 側も dropped として揃える
 * - `failed` / `unavailable`: 理由付きのエラーを投げる(訳文が無い以上、抽出も暗黙にフォールバックしない)
 * - エントリ無し / `pending`: 確定するまで翻訳ストアを購読して待つ(パイプライン停止時は signal で中断される)
 */
function waitForReverseTranslation(messageId: string, signal: AbortSignal): Promise<MessageSegment[]> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const settle = (): boolean => {
      const entry = useTranslationStore.getState().entries[messageId];
      if (!entry || entry.status === "pending") return false;
      unsubscribe();
      switch (entry.status) {
        case "done":
          resolve(entry.segments);
          return true;
        case "dropped":
          reject(new LowPriorityQueueOverflowError());
          return true;
        default:
          reject(
            new Error(
              `Could not pick up from the translation because it was not generated (translation status: ${entry.status}${
                entry.status === "failed" ? `, reason: ${entry.reason}` : ""
              })`,
            ),
          );
          return true;
      }
    };
    if (settle()) return;
    unsubscribe = useTranslationStore.subscribe(() => {
      settle();
    });
    signal.addEventListener(
      "abort",
      () => {
        unsubscribe();
        reject(new Error("The pickup pipeline was stopped while waiting for the translation"));
      },
      { once: true },
    );
  });
}

/**
 * 順方向のジョブオプション。表示中の発言者名(username / displayName)を
 * 除外名として渡す(issue #26。@ 無しで本文に書かれたユーザー名を抽出結果から落とすため)
 */
function buildPickupJobOptions(message: TwitchChatMessage, context: AutoPipelineJobContext) {
  return {
    priority: "low" as const,
    signal: context.signal,
    emotes: message.emotes,
    excludedNames: collectExcludedNames(context),
  };
}

/** 表示中の発言者名(username / displayName)の一覧。順方向・逆方向の除外名として共通で使う */
function collectExcludedNames({ getMessages }: AutoPipelineJobContext): string[] {
  return getMessages().flatMap((item) => [item.username, item.displayName]);
}

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
