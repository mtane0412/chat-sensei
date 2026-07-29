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
 *
 * 画面再マウント時のリスナー多重登録など、呼び出し側の事情で同一の発言が
 * 複数回 `processMessage` に渡されるケースへの防御として、直近に処理した
 * `message.id` のリングバッファも別途保持し、本文の重複判定(recentTexts)とは
 * 独立に二重処理を防ぐ。
 */
import { evaluateAutoExtractionCandidate, type AutoExtractionStrictness } from "../twitch/message-filter";
import type { TwitchChatMessage } from "../twitch/irc-parser";
import { createCandidate } from "../db/candidates";
import { explainChatMessage } from "./explain";
import { triageChatMessage } from "./triage";
import type { SessionPool } from "./session-pool";
import type { SupportedLanguage } from "./prompts";

/** 直近の重複判定に使うリングバッファの既定保持件数(本文用) */
const DEFAULT_RECENT_TEXTS_BUFFER_SIZE = 50;
/**
 * 直近に処理した message.id を覚えておくリングバッファの保持件数。
 * 本文の重複判定バッファ(recentTextsBufferSize)とは独立した固定値とする
 * (本文用バッファを短く設定していても、id重複防止は機能させたいため)。
 */
const PROCESSED_MESSAGE_ID_BUFFER_SIZE = 50;

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
  const processedMessageIds: string[] = [];
  const processedMessageIdSet = new Set<string>();

  function rememberText(text: string): void {
    recentTexts.push(text);
    if (recentTexts.length > bufferSize) {
      recentTexts.shift();
    }
  }

  function rememberMessageId(id: string): void {
    processedMessageIdSet.add(id);
    processedMessageIds.push(id);
    if (processedMessageIds.length > PROCESSED_MESSAGE_ID_BUFFER_SIZE) {
      const oldestId = processedMessageIds.shift();
      if (oldestId !== undefined) {
        processedMessageIdSet.delete(oldestId);
      }
    }
  }

  return {
    async processMessage(message, options) {
      // id は取得できない場合 null になりうる(irc-parser.ts参照)。
      // null 同士を誤って同一発言とみなさないよう、id がある場合のみ重複チェックの対象にする。
      if (message.id !== null) {
        if (processedMessageIdSet.has(message.id)) {
          return;
        }
        rememberMessageId(message.id);
      }

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
