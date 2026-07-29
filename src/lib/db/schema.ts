/**
 * IndexedDB(Dexie)のスキーマ定義。
 *
 * chat-sensei はサーバーを持たないクライアントサイド専用アプリのため、
 * Twitchチャットの受信メッセージと学習者が作成した単語帳カードをすべて
 * ブラウザのIndexedDBに保存する。このファイルはテーブル定義と型のみを持ち、
 * CRUD操作は `cards.ts` / `messages.ts` に委譲する。
 */
import Dexie, { type Table } from "dexie";
import type { EmotePosition } from "../twitch/irc-parser";
import type { ExplanationItemKind } from "../ai/schemas";
import type { SupportedLanguage } from "../ai/prompts";

/** Twitchチャットの1メッセージを永続化した形 */
export interface StoredMessage {
  id?: number;
  /** 先頭の `#` を除いたチャンネル名 */
  channel: string;
  userId: string | null;
  displayName: string;
  color: string | null;
  text: string;
  emotes: EmotePosition[];
  /** `tmi-sent-ts` 由来のミリ秒UNIXタイムスタンプ。取得できない場合は null */
  timestampMs: number | null;
  /** Language Detector API の判定結果(未判定・低確信度は null) */
  detectedLang: string | null;
  /** 判定の確信度(0〜1)。未判定は null */
  confidence: number | null;
}

/**
 * SM-2間隔反復アルゴリズムの状態(Phase 5「復習クイズ」で使用)。
 * Phase 3時点ではカード作成時に初期値を保存するのみで、採点ロジックは実装しない。
 */
export interface CardSrsState {
  /** 次回復習予定日時(epoch ms) */
  due: number;
  /** 復習間隔(日) */
  interval: number;
  easeFactor: number;
  repetitions: number;
  lapses: number;
  /** 最後に復習した日時(epoch ms)。未復習は null */
  lastReviewedAt: number | null;
}

/** 単語帳カード(教材本体) */
export interface Card {
  id?: number;
  /** 元のチャット本文中に登場する語句・フレーズそのもの */
  term: string;
  kind: ExplanationItemKind;
  /** 解説言語での意味 */
  meaning: string;
  /** 使われ方についての一言メモ */
  note: string;
  /** カード化の元になったチャット発言の全文 */
  sourceMessageText: string;
  sourceChannel: string;
  sourceAuthor: string;
  /** 学ぶ言語(カード化時点の設定を保存する) */
  targetLang: SupportedLanguage;
  /** 解説言語(カード化時点の設定を保存する) */
  explainLang: SupportedLanguage;
  tags: string[];
  /** 作成日時(epoch ms) */
  createdAt: number;
  srs: CardSrsState;
}

/** 復習履歴(Phase 5「復習クイズ」で使用) */
export interface Review {
  id?: number;
  cardId: number;
  /** 採点(Again/Hard/Good/Easyなど、Phase 5で定義する) */
  grade: number;
  reviewedAt: number;
}

/**
 * chat-sensei の Dexie データベース。
 *
 * テスト(fake-indexeddb)ではテストごとに異なる `name` を渡すことで、
 * IndexedDBの状態を独立させられるようにコンストラクタ引数化している。
 */
export class ChatSenseiDatabase extends Dexie {
  messages!: Table<StoredMessage, number>;
  cards!: Table<Card, number>;
  reviews!: Table<Review, number>;

  constructor(name = "chat-sensei") {
    super(name);
    this.version(1).stores({
      messages: "++id, channel, timestampMs",
      cards: "++id, term, kind, createdAt, *tags",
      reviews: "++id, cardId, reviewedAt",
    });
  }
}

/** アプリ全体で共有する既定のデータベースインスタンス */
export const db = new ChatSenseiDatabase();
