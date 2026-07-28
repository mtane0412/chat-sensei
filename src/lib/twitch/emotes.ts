/**
 * Twitch emote(絵文字)を表示するための純関数群。
 *
 * `irc-parser.ts` が emotes タグから抽出した位置情報(EmotePosition[])を、
 * (1) 実際に読み込む画像CDN URL、(2) テキスト/画像が交互に並ぶ描画用セグメント
 * に変換する。ライブチャットUIはこのセグメント列をそのまま描画すればよい。
 *
 * 注意: emote の開始・終了位置は文字列の(UTF-16コードユニット単位の)インデックスであるため、
 * サロゲートペアとなる絵文字を本文中に含むメッセージでは位置がずれる可能性がある。
 * MVPでは英語圏チャンネルの一般的なメッセージを主対象とするため、簡易な文字列スライスで扱う。
 */
import type { EmotePosition } from "./irc-parser";

export type EmoteTheme = "light" | "dark";
export type EmoteScale = "1.0" | "2.0" | "3.0";

export interface EmoteImageOptions {
  theme?: EmoteTheme;
  scale?: EmoteScale;
}

/** 本文の一部を、そのままのテキストとして表示するセグメント */
export interface TextSegment {
  type: "text";
  text: string;
}

/** 本文の一部を、emote画像として表示するセグメント(altテキストとして元の文字列も保持する) */
export interface EmoteSegment {
  type: "emote";
  id: string;
  text: string;
}

export type MessageSegment = TextSegment | EmoteSegment;

/**
 * emote ID から Twitch の emote 画像CDN URLを組み立てる。
 * デフォルトはダークテーマ・2倍サイズ(ライブチャット表示に適したサイズ)。
 */
export function buildEmoteImageUrl(emoteId: string, options: EmoteImageOptions = {}): string {
  const theme = options.theme ?? "dark";
  const scale = options.scale ?? "2.0";
  return `https://static-cdn.jtvnw.net/emoticons/v2/${emoteId}/default/${theme}/${scale}`;
}

/**
 * メッセージ本文を、テキストセグメントとemoteセグメントが交互に並ぶ配列に分割する。
 * emote が無い場合はテキスト1件のみの配列を返す。
 */
export function splitMessageIntoSegments(text: string, emotes: EmotePosition[]): MessageSegment[] {
  if (emotes.length === 0) {
    return [{ type: "text", text }];
  }

  // タグの記載順が文字位置順とは限らないため、開始位置で並べ替えてから走査する
  const sortedEmotes = [...emotes].sort((a, b) => a.start - b.start);

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const emote of sortedEmotes) {
    if (emote.start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, emote.start) });
    }
    segments.push({ type: "emote", id: emote.id, text: text.slice(emote.start, emote.end + 1) });
    cursor = emote.end + 1;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }

  return segments;
}
