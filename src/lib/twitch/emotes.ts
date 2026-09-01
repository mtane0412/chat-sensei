/**
 * Twitch emote(絵文字)を表示するための純関数群。
 *
 * `irc-parser.ts` が emotes タグから抽出した位置情報(EmotePosition[])を、
 * (1) 実際に読み込む画像CDN URL、(2) テキスト/画像が交互に並ぶ描画用セグメント
 * に変換する。ライブチャットUIはこのセグメント列をそのまま描画すればよい。
 * また、翻訳文のように位置情報を持たないテキストに対しては、元の発言に含まれていた
 * emote 名を手がかりに同じセグメント列へ分割する(`splitTextByEmoteNames`、issue #28)。
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

/** 正規表現のメタ文字をエスケープする(emote 名は英数字のみだが念のため) */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 位置情報を持たないテキスト(翻訳文など)を、既知の emote 名を手がかりにテキスト/emote セグメントに分割する。
 *
 * - `knownEmotes` は元の発言の `splitMessageIntoSegments` から得た emote セグメント(名前と ID の対応)
 * - 名前の照合は大文字小文字を区別する(Twitch の emote 名は大文字小文字を区別するため)
 * - 英数字の単語の一部(例: `Kappajapan` 内の `Kappa`)は emote とみなさないが、
 *   日本語などの非英数字には隣接していてもよい(翻訳文では `なんでsayuwuLulそんな` のように連結されるため)
 * - 同じ名前が複数の ID で登録されている場合は先勝ちとする
 */
export function splitTextByEmoteNames(text: string, knownEmotes: Array<Pick<EmoteSegment, "id" | "text">>): MessageSegment[] {
  if (knownEmotes.length === 0 || text === "") {
    return [{ type: "text", text }];
  }

  const idByName = new Map<string, string>();
  for (const emote of knownEmotes) {
    if (!idByName.has(emote.text)) idByName.set(emote.text, emote.id);
  }
  // 長い名前を先に並べ、ある emote 名が別の emote 名の接頭辞になっている場合でも長い方を優先する
  const names = [...idByName.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(?<![A-Za-z0-9_])(?:${names.map(escapeRegExp).join("|")})(?![A-Za-z0-9_])`, "g");

  const segments: MessageSegment[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const name = match[0];
    const id = idByName.get(name);
    // パターンは idByName のキーから組み立てているため必ず見つかるが、型上の未定義を Fail-Fast で弾く
    if (id === undefined) throw new Error(`emote 名に対応する ID がありません: ${name}`);
    if (match.index > cursor) {
      segments.push({ type: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({ type: "emote", id, text: name });
    cursor = match.index + name.length;
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ type: "text", text: text.slice(cursor) });
  }
  return segments;
}
