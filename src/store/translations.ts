/**
 * 中央列「翻訳」の状態を保持するストアと、受信した発言を自動で翻訳ジョブに流し込むパイプライン。
 *
 * パイプラインの流れ(診断待ちの保留・低優先度キューへの投入・結果の保持・ウォームアップ・破棄)は
 * `auto-pipeline.ts` の共通ファクトリに任せ、ここでは翻訳固有の部分だけを定義する。
 *
 * - LLM を呼ばずに確定させる発言: emote だけの発言(issue #28)と `!` で始まるチャットコマンド(issue #35)は
 *   原文をそのまま訳文として `done` にする(LLM に渡すと emote 名やコマンドを訳・音訳してしまうため)
 * - ジョブ: `translateChatMessage` を低優先度で実行し、訳文を `translation` として保持する
 * - Prompt API の利用可否は `prompt-api.ts` の共有ストアを参照する(Pick up 列と共通)
 */
import { createTranslateBaseSessionFactory, translateChatMessage } from "@/lib/ai/translate";
import { isChatCommandMessage } from "@/lib/twitch/chat-command";
import { isEmoteOnlyMessage } from "@/lib/twitch/emotes";
import { createAutoPipeline, type AutoPipelineDeps, type PipelineEntry } from "./auto-pipeline";

/** 翻訳の完了時に保持する結果 */
export interface TranslationDone {
  translation: string;
}

/** 発言1件ぶんの翻訳の状態 */
export type TranslationEntry = PipelineEntry<TranslationDone>;

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export type TranslationPipelineDeps = AutoPipelineDeps;

const pipeline = createAutoPipeline<TranslationDone>({
  createBaseSession: (settings) => createTranslateBaseSessionFactory(settings.targetLang, settings.explainLang),
  resolveWithoutModel: (message) =>
    isEmoteOnlyMessage(message.text, message.emotes) || isChatCommandMessage(message.text)
      ? { translation: message.text }
      : null,
  runJob: (pool, message, { signal }) => translateChatMessage(pool, message.text, { priority: "low", signal }),
});

export const useTranslationStore = pipeline.useStore;

/** 翻訳パイプラインを開始する。戻り値の関数で停止する。ホーム画面のマウント時に1回呼び出す想定 */
export const startTranslationPipeline = pipeline.start;

/**
 * 翻訳用ベースセッションを先に生成する。「接続する」クリックなどユーザー操作の
 * ハンドラから呼ぶこと(モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要)。
 */
export const warmUpTranslationPipeline = pipeline.warmUp;

/** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
export const resetTranslationStoreForTests = pipeline.resetForTests;
