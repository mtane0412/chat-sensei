/**
 * チャット欄から除外する bot のユーザー名パターンを扱うモジュール。
 *
 * - パターンは Twitch のログイン名(小文字)に対して照合する。`*` は任意の文字列に一致する
 *   ワイルドカードで、配信者ごとに個別のアカウントで運用される翻訳bot(`*trans`)や
 *   `*bot` のような命名の bot を一括で除外できる。`*` を含まないパターンは完全一致
 * - パターンに加えて、配信者(broadcaster)自身の発言を除外するトグル(`excludeBroadcaster`)を持つ。
 *   配信者アカウントで bot 的なコメント(定型文・アラート等)を流す配信者が多いため、
 *   接続中チャンネル名(= 配信者のログイン名)との一致で除外できるようにする
 * - 設定は LocalStorage に `{ patterns, excludeBroadcaster }` のオブジェクトとして永続化する
 *   (chat-sensei はサーバー不要のクライアントサイド専用アプリ)。旧形式(文字列配列のみ)の
 *   保存データは配信者除外オフとして復元する。保存データが壊れている場合は暗黙に補正せず、
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

/** 旧形式の保存データ(パターンの文字列配列のみ。excludeBroadcaster 追加前) */
const legacyBotFilterPatternsSchema = z.array(z.string());

const botFilterConfigSchema = z.object({
  patterns: z.array(z.string()),
  excludeBroadcaster: z.boolean(),
});

/** bot除外設定の全体(除外パターン + 配信者自身を除外するか) */
export interface BotFilterConfig {
  /** 除外するユーザー名パターン(`*` ワイルドカード可、小文字) */
  patterns: readonly string[];
  /** 接続中チャンネルの配信者自身の発言も除外するか */
  excludeBroadcaster: boolean;
}

export const DEFAULT_BOT_FILTER_CONFIG: BotFilterConfig = {
  patterns: DEFAULT_BOT_FILTER_PATTERNS,
  excludeBroadcaster: false,
};

export interface LoadBotFilterConfigResult {
  config: BotFilterConfig;
  /** 保存されていた値が壊れていた(JSON不正・スキーマ不一致)ため、デフォルトに戻した場合 true */
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

/**
 * 発言をチャット欄から除外すべきか。除外パターンとの一致に加え、配信者除外がオンの場合は
 * 接続中チャンネル名(= 配信者のログイン名。小文字)との一致でも除外する。
 * 未接続(channel が null)の間は配信者除外では除外しない。
 */
export function isExcludedFromChat(username: string, channel: string | null, config: BotFilterConfig): boolean {
  if (config.excludeBroadcaster && channel !== null && username.toLowerCase() === channel.toLowerCase()) {
    return true;
  }
  return matchesBotFilter(username, config.patterns);
}

function ensureBrowserEnvironment(): void {
  if (typeof window === "undefined") {
    throw new Error("bot-filter.ts の保存・復元関数はブラウザ環境でのみ呼び出せます(SSR中に呼び出さないでください)");
  }
}

/** LocalStorage からbot除外設定を読み込む。無い場合はデフォルト、壊れている場合はデフォルト + wasCorrupted を返す */
export function loadBotFilterConfig(): LoadBotFilterConfigResult {
  ensureBrowserEnvironment();

  const raw = window.localStorage.getItem(BOT_FILTER_STORAGE_KEY);
  if (raw === null) {
    return { config: DEFAULT_BOT_FILTER_CONFIG, wasCorrupted: false };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    // 旧形式(パターンの文字列配列のみ)は、配信者除外オフとして新形式へ移行する
    if (Array.isArray(parsed)) {
      return {
        config: { patterns: legacyBotFilterPatternsSchema.parse(parsed), excludeBroadcaster: false },
        wasCorrupted: false,
      };
    }
    return { config: botFilterConfigSchema.parse(parsed), wasCorrupted: false };
  } catch {
    return { config: DEFAULT_BOT_FILTER_CONFIG, wasCorrupted: true };
  }
}

/** bot除外設定を LocalStorage に保存する。空のパターン配列(すべて除外しない)も保存できる */
export function saveBotFilterConfig(config: BotFilterConfig): void {
  ensureBrowserEnvironment();
  window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify(botFilterConfigSchema.parse(config)));
}
