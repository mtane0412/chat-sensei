/**
 * 中央列「翻訳」の状態を保持するストアと、受信した発言を自動で翻訳ジョブに流し込むパイプライン。
 *
 * パイプラインの流れ(診断待ちの保留・低優先度キューへの投入・結果の保持・ウォームアップ・破棄)は
 * `auto-pipeline.ts` の共通ファクトリに任せ、ここでは翻訳固有の部分だけを定義する。
 *
 * - LLM を呼ばずに確定させる発言: 訳す文字を含まない発言(emote だけ = issue #28、Unicode 絵文字だけ、記号だけ)と
 *   `!` で始まるチャットコマンド(issue #35)は原文をそのまま訳文として `done` にする
 *   (LLM に渡すと emote 名やコマンドを訳・音訳してしまい、言語判定に回すと無関係な言語になるため)
 * - ジョブ: emote を `[[E0]]` のようなプレースホルダに置き換えた本文で `translateChatMessage` を低優先度で実行し、
 *   訳文中のプレースホルダを emote セグメントに戻した `segments` を保持する(issue #44。LLM に emote 名を
 *   見せると意訳して書き換えることがあり、名前の一致では復元できないため)
 * - 発言ごとの言語判定(学ぶ言語ならその言語のセッションプールへ、解説言語と同じ・対象外ならスキップ)は
 *   `auto-pipeline.ts` が行う。ベースセッションは「学ぶ言語 1 つ × 解説言語」のペアごとに組み立てる
 * - Prompt API の利用可否は `prompt-api.ts` の共有ストアを参照する(Pick up 列と共通)
 */
import { createTranslateBaseSessionFactory, translateChatMessage } from "@/lib/ai/translate";
import { isChatCommandMessage } from "@/lib/twitch/chat-command";
import {
  isTextlessMessage,
  maskEmotesWithPlaceholders,
  restoreEmotesFromPlaceholders,
  splitMessageIntoSegments,
  type MessageSegment,
} from "@/lib/twitch/emotes";
import { createAutoPipeline, type AutoPipelineDeps, type PipelineEntry } from "./auto-pipeline";
import { useSettingsStore } from "./settings";
import { getStreamInfo } from "./stream-info";

/** 翻訳の完了時に保持する結果。訳文はページがそのまま描画できるテキスト/emote セグメント列で持つ */
export interface TranslationDone {
  segments: MessageSegment[];
}

/** 発言1件ぶんの翻訳の状態 */
export type TranslationEntry = PipelineEntry<TranslationDone>;

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export type TranslationPipelineDeps = AutoPipelineDeps;

const pipeline = createAutoPipeline<TranslationDone>({
  // ベースセッションは設定(LLM プロバイダ)と配信の文脈(タイトル・カテゴリ。issue #54)に依存する。
  // 設定変更時・配信情報の変化時はホーム画面がパイプラインを再起動し、プールも作り直されるため、
  // 生成時点のストアの値を読めばよい
  createBaseSession: (targetLang, explainLang) =>
    createTranslateBaseSessionFactory(useSettingsStore.getState().settings, targetLang, explainLang, getStreamInfo()),
  // 逆方向は翻訳元・訳文の言語を入れ替えるだけでよいため、順方向のファクトリを引数の入れ替えで流用する
  // (システムプロンプトは学ぶ言語で書かれ、解説言語→学ぶ言語の翻訳を指示する)。
  // ジョブの処理は順方向と同一のため runReverseJob は定義せず、共通ファクトリのフォールバック(runJob)に任せる
  createReverseBaseSession: (learningLang, explainLang) =>
    createTranslateBaseSessionFactory(useSettingsStore.getState().settings, explainLang, learningLang, getStreamInfo()),
  resolveWithoutModel: (message) =>
    isTextlessMessage(message.text, message.emotes) || isChatCommandMessage(message.text)
      ? { segments: splitMessageIntoSegments(message.text, message.emotes) }
      : null,
  runJob: async (pool, message, { signal }) => {
    const { maskedText, placeholders } = maskEmotesWithPlaceholders(message.text, message.emotes);
    const { translation } = await translateChatMessage(pool, maskedText, {
      priority: "low",
      signal,
      placeholderTokens: placeholders.map((placeholder) => placeholder.token),
    });
    return { segments: restoreEmotesFromPlaceholders(translation, placeholders) };
  },
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
