/**
 * Twitch emote(絵文字)を表示するための純関数群。
 *
 * `irc-parser.ts` が emotes タグから抽出した位置情報(EmotePosition[])を、
 * (1) 実際に読み込む画像CDN URL、(2) テキスト/画像が交互に並ぶ描画用セグメント
 * に変換する。ライブチャットUIはこのセグメント列をそのまま描画すればよい。
 * また、翻訳の LLM に emote 名を書き換えられないよう、送信前に emote をプレースホルダへ置き換え、
 * 受信後に訳文中のプレースホルダを emote セグメントへ戻す
 * (`maskEmotesWithPlaceholders` / `restoreEmotesFromPlaceholders`、issue #28 → #44)。
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

/**
 * emote だけ(空白を除いてすべてが emote)の発言かを判定する。
 * 訳すべきテキストが無いため、翻訳側は LLM を呼ばずに原文をそのまま扱える(issue #28)。
 * emote が無い発言は、本文が空であっても false を返す(emote 以外の理由での空は呼び出し側の判断に委ねる)。
 */
export function isEmoteOnlyMessage(text: string, emotes: EmotePosition[]): boolean {
  if (emotes.length === 0) return false;
  return splitMessageIntoSegments(text, emotes).every(
    (segment) => segment.type === "emote" || segment.text.trim() === "",
  );
}

/** 正規表現のメタ文字をエスケープする */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** LLM に渡す本文の中で emote 1 件を置き換えるプレースホルダと、元の emote(ID・名前)の対応 */
export interface EmotePlaceholder {
  /** 本文中に埋め込む記号トークン(例: `[[E0]]`) */
  token: string;
  id: string;
  /** 元の emote 名(復元後の alt テキストに使う) */
  text: string;
}

export interface MaskedEmoteText {
  /** emote をすべてプレースホルダに置き換えた本文 */
  maskedText: string;
  /** 出現順のプレースホルダ一覧。emote が無ければ空 */
  placeholders: EmotePlaceholder[];
}

/** 出現順の連番から、記号だけで構成され翻訳で意訳されにくいプレースホルダを作る */
function buildEmotePlaceholderToken(index: number): string {
  return `[[E${index}]]`;
}

/**
 * 発言本文の emote を `[[E0]]`, `[[E1]]` のようなプレースホルダに置き換える(issue #44)。
 *
 * 翻訳の LLM に emote 名(`peepoWave` など)をそのまま見せると、名前の一部を意訳して書き換える
 * (`🥺Wave` など)ことがあり、訳文から emote を復元できなくなる。emote の位置は `emotes` タグから
 * 正確に分かるため、送信前に決定的に記号へ置き換え、受信後に `restoreEmotesFromPlaceholders` で戻す。
 * 同じ emote が複数回現れても出現ごとに別のトークンを割り当てる(訳文中の位置をそのまま保つため)。
 */
export function maskEmotesWithPlaceholders(text: string, emotes: EmotePosition[]): MaskedEmoteText {
  const placeholders: EmotePlaceholder[] = [];
  const maskedText = splitMessageIntoSegments(text, emotes)
    .map((segment) => {
      if (segment.type === "text") return segment.text;
      const token = buildEmotePlaceholderToken(placeholders.length);
      placeholders.push({ token, id: segment.id, text: segment.text });
      return token;
    })
    .join("");
  return { maskedText, placeholders };
}

/**
 * 訳文中のプレースホルダを `maskEmotesWithPlaceholders` の置換表で emote セグメントに戻す(issue #44)。
 *
 * - 置換表に無いプレースホルダ風の文字列(LLM の創作)はテキストとして残し、黙って消さない
 * - LLM が訳文から落としたプレースホルダは、emote 画像が失われないよう末尾に空白区切りで補う
 *   (訳文中の正しい位置は分からないため、位置の推測はしない)
 */
export function restoreEmotesFromPlaceholders(translation: string, placeholders: EmotePlaceholder[]): MessageSegment[] {
  if (placeholders.length === 0) {
    return [{ type: "text", text: translation }];
  }

  const byToken = new Map(placeholders.map((placeholder) => [placeholder.token, placeholder]));
  const pattern = new RegExp(placeholders.map((placeholder) => escapeRegExp(placeholder.token)).join("|"), "g");

  const segments: MessageSegment[] = [];
  const restoredTokens = new Set<string>();
  let cursor = 0;
  for (const match of translation.matchAll(pattern)) {
    const placeholder = byToken.get(match[0]);
    // パターンは置換表のトークンから組み立てているため必ず見つかるが、型上の未定義を Fail-Fast で弾く
    if (placeholder === undefined) throw new Error(`プレースホルダに対応する emote がありません: ${match[0]}`);
    if (match.index > cursor) {
      segments.push({ type: "text", text: translation.slice(cursor, match.index) });
    }
    segments.push({ type: "emote", id: placeholder.id, text: placeholder.text });
    restoredTokens.add(placeholder.token);
    cursor = match.index + match[0].length;
  }
  if (cursor < translation.length) {
    segments.push({ type: "text", text: translation.slice(cursor) });
  }

  for (const placeholder of placeholders) {
    if (restoredTokens.has(placeholder.token)) continue;
    if (segments.length > 0) segments.push({ type: "text", text: " " });
    segments.push({ type: "emote", id: placeholder.id, text: placeholder.text });
  }
  return segments;
}
