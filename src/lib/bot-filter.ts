/**
 * チャット欄から除外する bot のユーザー名パターンを扱うモジュール。
 *
 * - パターンは Twitch のログイン名(小文字)に対して照合する。`*` は任意の文字列に一致する
 *   ワイルドカードで、配信者ごとに個別のアカウントで運用される翻訳bot(`*trans`)や
 *   `*bot` のような命名の bot を一括で除外できる。`*` を含まないパターンは完全一致
 * - 設定は LocalStorage に文字列配列としてのみ永続化する(chat-sensei はサーバー不要の
 *   クライアントサイド専用アプリ)。保存データが壊れている場合は暗黙に補正せず、
 *   デフォルトへ戻したうえで `wasCorrupted: true` を返して呼び出し元が利用者に伝えられるようにする
 *   (CLAUDE.md の Fail-Fast 方針。`settings.ts` と同じ規約)
 */
import { z } from "zod";

export const BOT_FILTER_STORAGE_KEY = "chat-sensei:bot-filter";

/**
 * 初期状態で除外する著名な Twitch bot。
 * 多くの配信で共通して使われるチャットbot・アラートbot・ゲーム系botのログイン名を列挙する。
 */
export const DEFAULT_BOT_FILTER_PATTERNS: readonly string[] = [
  "nightbot",
  "streamelements",
  "streamlabs",
  "moobot",
  "fossabot",
  "wizebot",
  "botrix",
  "sery_bot",
  "soundalerts",
  "pokemoncommunitygame",
  "kofistreambot",
  "streamstickers",
  "own3d",
  "blerp",
  "lumiastream",
  "commanderroot",
];

const botFilterPatternsSchema = z.array(z.string());

export interface LoadBotFilterPatternsResult {
  patterns: readonly string[];
  /** 保存されていた値が壊れていた(JSON不正・文字列配列でない)ため、デフォルトに戻した場合 true */
  wasCorrupted: boolean;
}

/**
 * 入力欄のテキストをパターンの配列にする。
 * 改行・カンマ・空白のいずれで区切っても良い。空要素と重複は取り除き、小文字に正規化する。
 */
export function parseBotFilterPatterns(text: string): string[] {
  const patterns = text
    .split(/[\n,\s]+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length > 0);
  return Array.from(new Set(patterns));
}

/** パターンの配列を、入力欄に表示する1行1件のテキストに戻す */
export function formatBotFilterPatterns(patterns: readonly string[]): string {
  return patterns.join("\n");
}

/** 正規表現のメタ文字をエスケープする(`*` 以外をそのままの文字として照合するため) */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 1件のパターン(`*` ワイルドカード付き)を、ユーザー名全体に一致する正規表現へ変換する */
function patternToRegExp(pattern: string): RegExp {
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "i");
}

/** ユーザー名がいずれかの除外パターンに一致するか(大文字小文字は区別しない) */
export function matchesBotFilter(username: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => patternToRegExp(pattern).test(username));
}

function ensureBrowserEnvironment(): void {
  if (typeof window === "undefined") {
    throw new Error("bot-filter.ts の保存・復元関数はブラウザ環境でのみ呼び出せます(SSR中に呼び出さないでください)");
  }
}

/** LocalStorage から除外パターンを読み込む。無い場合はデフォルト、壊れている場合はデフォルト + wasCorrupted を返す */
export function loadBotFilterPatterns(): LoadBotFilterPatternsResult {
  ensureBrowserEnvironment();

  const raw = window.localStorage.getItem(BOT_FILTER_STORAGE_KEY);
  if (raw === null) {
    return { patterns: DEFAULT_BOT_FILTER_PATTERNS, wasCorrupted: false };
  }

  try {
    const patterns = botFilterPatternsSchema.parse(JSON.parse(raw));
    return { patterns, wasCorrupted: false };
  } catch {
    return { patterns: DEFAULT_BOT_FILTER_PATTERNS, wasCorrupted: true };
  }
}

/** 除外パターンを LocalStorage に保存する。空配列(すべて除外しない)も保存できる */
export function saveBotFilterPatterns(patterns: readonly string[]): void {
  ensureBrowserEnvironment();
  window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify(botFilterPatternsSchema.parse(patterns)));
}
