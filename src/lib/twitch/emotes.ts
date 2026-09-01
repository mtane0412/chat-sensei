/**
 * Twitch emote(絵文字)を表示するための純関数群。
 *
 * `irc-parser.ts` が emotes タグから抽出した位置情報(EmotePosition[])を、
 * (1) 実際に読み込む画像CDN URL、(2) テキスト/画像が交互に並ぶ描画用セグメント
 * に変換する。ライブチャットUIはこのセグメント列をそのまま描画すればよい。
 *
 * 注意: Twitch の emotes タグの開始・終了位置は Unicode コードポイント単位である。
 * JavaScript の文字列インデックスは UTF-16 コードユニット単位のため、サロゲートペアとなる
 * 絵文字(🌿 など)が emote より前にあると位置がずれる。`splitMessageIntoSegments` は
 * コードポイント位置を UTF-16 位置に変換してから切り出す(issue #26 の実ブラウザ確認で発覚)。
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
 * コードポイント単位の位置を UTF-16 コードユニット単位の位置に変換する表を作る。
 * `offsets[i]` はi番目のコードポイントの開始位置。末尾に文字列長を番兵として持ち、
 * 範囲外の位置を引いても文字列末尾に丸められるようにする。
 */
function buildCodePointOffsets(text: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const codePoint of text) {
    offsets.push(offset);
    offset += codePoint.length;
  }
  offsets.push(text.length);
  return offsets;
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
  const offsets = buildCodePointOffsets(text);
  const lastIndex = offsets.length - 1;
  /** コードポイント位置(inclusive の end も含む)を UTF-16 の開始位置に変換する */
  const toUtf16 = (codePointIndex: number): number => offsets[Math.min(codePointIndex, lastIndex)];

  const segments: MessageSegment[] = [];
  let cursor = 0;

  for (const emote of sortedEmotes) {
    const start = toUtf16(emote.start);
    // end は inclusive なので、次のコードポイントの開始位置を exclusive な終端として使う
    const end = toUtf16(emote.end + 1);
    if (start > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, start) });
    }
    segments.push({ type: "emote", id: emote.id, text: text.slice(start, end) });
    cursor = end;
  }

  if (cursor < text.length) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }

  return segments;
}
