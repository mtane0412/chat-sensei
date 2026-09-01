/**
 * Pick up(注目の表現の抽出)の前後に置く、LLM を使わない決定的な処理(issue #26)。
 *
 * Gemini Nano はプロンプトで「emote 名・数字・@メンションは含めない」と指示しても
 * それらを「特殊な表現」として返すことがある。emote の位置は Twitch IRC の `emotes` タグで
 * 確定しているため、LLM に判断させず同じ入力なら必ず同じ結果になる処理で扱う。
 *
 * - `preparePickupInput`: 送信前の足切り。emote・@メンション・URL を本文から除き、
 *   LLM に渡す本文と、後段フィルタで照合するための emote 名・メンション名を返す
 * - `filterPickupTerms`: 後段フィルタ。返ってきた語句のうち emote 名・@メンション・
 *   `!` で始まるチャットコマンド・文字を1つも含まない語句(数字や記号だけ)・
 *   呼び出し側が指定した除外名(表示中の発言者名など)を落とし、重複する語句は1件にまとめる
 *
 * 翻訳列は「emote 名はそのまま残す」設計のため、この処理は Pick up 専用である。
 */
import { splitMessageIntoSegments } from "@/lib/twitch/emotes";
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import type { PickupTerm } from "./schemas";

/** `preparePickupInput` の結果。LLM に渡す本文と、後段フィルタの照合に使う情報 */
export interface PreparedPickupInput {
  /** LLM に渡す本文。emote・@メンション・URL を除き、連続する空白を1つにまとめた文字列 */
  text: string;
  /** 本文から除いた emote 名(重複なし) */
  emoteNames: string[];
  /** 本文から除いた @メンションのユーザー名(@ を外したもの、重複なし) */
  mentionNames: string[];
}

/** `@username` 形式のメンション。Twitch のユーザー名は英数字とアンダースコアのみ */
const MENTION_PATTERN = /@(\w+)/g;
/** http(s) で始まる URL。空白までを1つの URL とみなす */
const URL_PATTERN = /https?:\/\/\S+/g;
/** 文字(どの言語の文字でもよい)を1つも含まない語句にマッチする */
const NO_LETTER_PATTERN = /^[^\p{L}]*$/u;

/**
 * チャット本文から Pick up の対象にならないトークンを除き、LLM に渡す本文を組み立てる。
 * emote だけの発言では `text` が空文字列になる(呼び出し側は LLM を呼ばずに済ませられる)。
 */
export function preparePickupInput(text: string, emotes: EmotePosition[]): PreparedPickupInput {
  const emoteNames = new Set<string>();
  const textWithoutEmotes = splitMessageIntoSegments(text, emotes)
    .map((segment) => {
      if (segment.type === "emote") {
        emoteNames.add(segment.text);
        // 前後の語が連結しないよう、emote の位置は空白に置き換える
        return " ";
      }
      return segment.text;
    })
    .join("");

  const mentionNames = new Set<string>();
  const stripped = textWithoutEmotes
    .replace(MENTION_PATTERN, (_match, name: string) => {
      mentionNames.add(name);
      return " ";
    })
    .replace(URL_PATTERN, " ");

  return {
    text: stripped.replace(/\s+/g, " ").trim(),
    emoteNames: [...emoteNames],
    mentionNames: [...mentionNames],
  };
}

/**
 * LLM が返した語句から、決定的に「注目の表現ではない」と判別できるものを落とす。
 * 照合は大文字小文字を区別しない(`pickup.ts` の原文照合と同じ基準)。
 *
 * @param extraExcludedNames 呼び出し側が追加で除外したい名前(表示中の発言者名など)
 */
export function filterPickupTerms(
  terms: PickupTerm[],
  prepared: PreparedPickupInput,
  extraExcludedNames: string[] = [],
): PickupTerm[] {
  const excludedNames = new Set(
    [...prepared.emoteNames, ...prepared.mentionNames, ...extraExcludedNames].map((name) => name.toLowerCase()),
  );
  /** 既に残した語句(小文字化済み)。同じ語句が繰り返し返ってきても最初の1件だけ残す */
  const seen = new Set<string>();
  return terms.filter((item) => {
    const normalized = item.term.trim().toLowerCase();
    // @メンションと、`!chimkin` のようなチャットコマンドは学ぶべき表現ではない
    if (normalized.startsWith("@") || normalized.startsWith("!")) return false;
    if (excludedNames.has(normalized)) return false;
    if (NO_LETTER_PATTERN.test(normalized)) return false;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
