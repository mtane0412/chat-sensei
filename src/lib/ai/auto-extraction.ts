/**
 * 自動抽出パイプライン: message-filter → triage → explain → candidates保存を束ねる
 * オーケストレーション層。
 *
 * ライブチャットの発言を1件ずつ `processMessage` に渡すと、以下を順に行う。
 * 1. `message-filter.ts` でノイズを除去する(LLM不使用)
 * 2. 通過した発言のみ `triage.ts` で学習価値をLLM判定する(低優先度)
 * 3. `true` と判定された発言のみ `explain.ts` で本解説を生成する(低優先度)
 * 4. 生成された各語句候補を `candidates` テーブルに保存する
 *
 * triage・explainは、手動ピック(高優先度)と同じ `SessionPool` を呼び出し側から
 * 受け取って共有する(design: 単一セッション + 優先度付き直列キュー)。
 * 直近の重複判定用のリングバッファは内部状態として保持するため、
 * 接続中のチャンネルにつき1つのインスタンスを使い回す想定。
 */
import { evaluateAutoExtractionCandidate, type AutoExtractionStrictness } from "../twitch/message-filter";
import type { TwitchChatMessage } from "../twitch/irc-parser";
import { createCandidate } from "../db/candidates";
import { explainChatMessage } from "./explain";
import { triageChatMessage } from "./triage";
import type { SessionPool } from "./session-pool";
import type { SupportedLanguage } from "./prompts";

/** 直近の重複判定に使うリングバッファの既定保持件数 */
const DEFAULT_RECENT_TEXTS_BUFFER_SIZE = 50;

export interface AutoExtractionPipelineDeps {
  /** 手動ピックと共有する SessionPool(単一セッションの優先度付き直列キュー) */
  sessionPool: SessionPool;
  /** 重複判定用リングバッファの最大保持件数。省略時 50 */
  recentTextsBufferSize?: number;
}

export interface ProcessMessageOptions {
  strictness: AutoExtractionStrictness;
  /** カード候補として保存する際に埋め込む、生成時点の言語ペア */
  targetLang: SupportedLanguage;
  explainLang: SupportedLanguage;
  signal?: AbortSignal;
}

export interface AutoExtractionPipeline {
  /** 1件のチャット発言を自動抽出パイプラインに投入する */
  processMessage(message: TwitchChatMessage, options: ProcessMessageOptions): Promise<void>;
}

export function createAutoExtractionPipeline(deps: AutoExtractionPipelineDeps): AutoExtractionPipeline {
  const bufferSize = deps.recentTextsBufferSize ?? DEFAULT_RECENT_TEXTS_BUFFER_SIZE;
  const recentTexts: string[] = [];

  function rememberText(text: string): void {
    recentTexts.push(text);
    if (recentTexts.length > bufferSize) {
      recentTexts.shift();
    }
  }

  return {
    async processMessage(message, options) {
      const rejection = evaluateAutoExtractionCandidate(message, {
        strictness: options.strictness,
        recentTexts,
      });
      rememberText(message.text);
      if (rejection) {
        return;
      }

      const worthLearning = await triageChatMessage(deps.sessionPool, message.text, { signal: options.signal });
      if (!worthLearning) {
        return;
      }

      const explanation = await explainChatMessage(deps.sessionPool, message.text, {
        priority: "low",
        signal: options.signal,
      });

      for (const item of explanation.items) {
        await createCandidate({
          term: item.term,
          kind: item.kind,
          meaning: item.meaning,
          note: item.note,
          sourceMessageText: message.text,
          sourceChannel: message.channel,
          sourceAuthor: message.displayName,
          targetLang: options.targetLang,
          explainLang: options.explainLang,
          tags: [],
        });
      }
    },
  };
}
