/**
 * 自動抽出パイプラインの最初の関門として、Twitchチャット発言をGemini Nano(Prompt API)に
 * 渡す前にコードだけで足切りする純関数群。LLMは一切使用しない。
 *
 * 除去対象: bot発言・`!`始まりのコマンド・emoteのみ・URLのみ・極端に短い発言・直近の重複。
 * Nanoの呼び出しコストを抑えるため、この段階を通過した発言だけが triage.ts に渡される。
 */
import { splitMessageIntoSegments } from "./emotes";
import type { TwitchChatMessage } from "./irc-parser";

/** 自動抽出の強度(フィルタの厳しさ)。厳しいほど「極端に短い発言」とみなす閾値が上がる */
export const AUTO_EXTRACTION_STRICTNESS_LEVELS = ["loose", "normal", "strict"] as const;
export type AutoExtractionStrictness = (typeof AUTO_EXTRACTION_STRICTNESS_LEVELS)[number];

/** 抽出強度ごとの最短文字数(前後の空白を除いた本文がこれ未満なら"too-short"として除去する) */
export const MIN_MESSAGE_LENGTH_BY_STRICTNESS: Record<AutoExtractionStrictness, number> = {
  loose: 2,
  normal: 4,
  strict: 10,
};

/** 発言が自動抽出候補から除去された理由 */
export const FILTER_REJECTION_REASONS = [
  "bot",
  "command",
  "emote-only",
  "url-only",
  "too-short",
  "duplicate",
] as const;
export type FilterRejectionReason = (typeof FILTER_REJECTION_REASONS)[number];

/**
 * 配信ツール系の定番Botとして広く知られたユーザー名(すべて小文字)。
 * Twitch IRCにはbotであることを示す公式タグが存在しないため、既知の名前のみを対象にする
 * (誤って一般利用者を除去しないよう、`bot`で終わるという緩い判定は行わない)。
 */
const KNOWN_BOT_USERNAMES = new Set([
  "nightbot",
  "streamelements",
  "moobot",
  "fossabot",
  "wizebot",
  "streamlabs",
  "commanderroot",
]);

/** `https://` または `http://` から始まるURLにマッチする(グローバルフラグはreplaceのみに使う) */
const URL_PATTERN = /https?:\/\/\S+/gi;

export interface EvaluateAutoExtractionCandidateOptions {
  /** 抽出強度。省略時は "normal" */
  strictness?: AutoExtractionStrictness;
  /** 重複判定に使う直近の発言本文一覧(正規化前の原文でよい) */
  recentTexts?: readonly string[];
}

function isKnownBotUsername(username: string): boolean {
  return KNOWN_BOT_USERNAMES.has(username.toLowerCase());
}

/** emote部分を取り除いた本文を返す(emotes.tsのセグメント分割を再利用する) */
function textWithoutEmotes(message: TwitchChatMessage): string {
  return splitMessageIntoSegments(message.text, message.emotes)
    .filter((segment) => segment.type === "text")
    .map((segment) => segment.text)
    .join("");
}

/** 比較用に前後の空白を除き小文字化する */
function normalizeForDuplicateCheck(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * チャット発言が自動抽出パイプラインの次段階(triage)に進めるかを判定する。
 * 通過する場合は `null`、除去する場合はその理由を返す
 * (該当しうる理由が複数あっても、`FILTER_REJECTION_REASONS` の列挙順で最初に一致したものを返す)。
 */
export function evaluateAutoExtractionCandidate(
  message: TwitchChatMessage,
  options: EvaluateAutoExtractionCandidateOptions = {},
): FilterRejectionReason | null {
  const strictness = options.strictness ?? "normal";
  const minLength = MIN_MESSAGE_LENGTH_BY_STRICTNESS[strictness];
  const trimmedText = message.text.trim();

  if (isKnownBotUsername(message.username)) {
    return "bot";
  }

  if (trimmedText.startsWith("!")) {
    return "command";
  }

  if (message.emotes.length > 0 && textWithoutEmotes(message).trim() === "") {
    return "emote-only";
  }

  if (trimmedText !== "" && trimmedText.replace(URL_PATTERN, "").trim() === "") {
    return "url-only";
  }

  if (trimmedText.length < minLength) {
    return "too-short";
  }

  const normalized = normalizeForDuplicateCheck(message.text);
  if (options.recentTexts?.some((recentText) => normalizeForDuplicateCheck(recentText) === normalized)) {
    return "duplicate";
  }

  return null;
}
