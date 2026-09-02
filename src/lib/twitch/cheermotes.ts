/**
 * Twitch の Cheering Emote(Cheermote: `Cheer100` / `showLove1000` など)への対応。
 *
 * bits 付きの PRIVMSG(`bits` タグあり)の本文には、Cheermote が
 * 「プレフィックス + bits 数」のトークン(例: `Cheer100`)としてそのまま含まれる。
 * `mergeCheermotePositions` はこのトークンを検出し、Twitch 公式 emote と同じ
 * `EmotePosition` として合成する。これにより下流(描画・翻訳のプレースホルダ化・
 * textless 判定)はサードパーティ emote(`third-party-emotes.ts`)と同様に
 * 既存の emote 処理をそのまま使える。
 *
 * - このアプリは Helix API を使わない匿名 IRC 接続のため、チャンネル独自の Cheermote は
 *   取得できない。Twitch 公式ドキュメントに載っているグローバル Cheermote の
 *   プレフィックスを静的な一覧として持つ(BibleThump / EleGiggle は CDN 上に
 *   画像が存在しなくなっているため一覧から除外した。2026-09 に確認)
 * - emote 位置はプレフィックス部分だけを覆い、bits 数はテキストとして残す
 *   (Twitch 本家のチャット UI と同じく「画像 + 数値」で表示するため)
 * - ID は `cheer:{プレフィックス小文字}/{ティア}` 形式とし、`emotes.ts` の
 *   `buildEmoteImageUrl` が静的 CDN の URL に組み立てる
 * - 位置は Twitch の `emotes` タグと同じくコードポイント単位・end は inclusive
 */
import type { EmotePosition } from "./irc-parser";

/**
 * グローバル Cheermote のプレフィックス一覧(小文字)。
 * 出典: https://dev.twitch.tv/docs/irc/emotes/(Cheermotes の節)
 */
const GLOBAL_CHEERMOTE_PREFIXES: ReadonlySet<string> = new Set([
  "cheer",
  "doodlecheer",
  "cheerwhal",
  "corgo",
  "uni",
  "showlove",
  "party",
  "seemsgood",
  "pride",
  "kappa",
  "frankerz",
  "heyguys",
  "dansgame",
  "trihard",
  "kreygasm",
  "4head",
  "swiftrage",
  "notlikethis",
  "failfish",
  "vohiyo",
  "pjsalt",
  "mrdestructoid",
  "bday",
  "ripcheer",
  "shamrock",
]);

/** Cheermote の画像が用意されている bits 数の閾値(降順) */
const CHEERMOTE_TIERS = [10000, 5000, 1000, 100, 1] as const;

/**
 * bits 数から Cheermote の表示ティア(画像・色の段階)を返す。
 * 1〜99 → 1、100〜999 → 100、1000〜4999 → 1000、5000〜9999 → 5000、10000〜 → 10000。
 */
export function resolveCheermoteTier(bits: number): number {
  for (const tier of CHEERMOTE_TIERS) {
    if (bits >= tier) return tier;
  }
  return 1;
}

/** 「英字プレフィックス + bits 数」のトークン(例: `Cheer100`)にマッチするパターン */
const CHEERMOTE_TOKEN_PATTERN = /^([a-zA-Z]+)(\d+)$/;

/** 既存の emote の位置範囲とトークンの範囲(いずれもコードポイント単位・inclusive)が重なるか */
function overlapsAnyEmote(start: number, end: number, emotes: EmotePosition[]): boolean {
  return emotes.some((emote) => start <= emote.end && end >= emote.start);
}

/**
 * bits 付き発言の本文から Cheermote トークンを検出し、Twitch 公式 emote の
 * 位置情報に合成して返す(開始位置の昇順)。bits が無い発言(null または 0 以下)では
 * Cheermote は成立しないため、公式 emote の位置情報をそのまま返す。
 *
 * - プレフィックスは Twitch の仕様どおり大文字小文字を区別せずに照合する
 * - 単語全体が「プレフィックス + 1 以上の数値」の場合のみ Cheermote とする
 * - emote 位置はプレフィックス部分だけを覆い、bits 数はテキストとして残す
 * - 公式 emote の範囲と重なる単語は公式 emote を優先して対象外とする
 */
export function mergeCheermotePositions(
  text: string,
  twitchEmotes: EmotePosition[],
  bits: number | null,
): EmotePosition[] {
  if (bits === null || bits <= 0) return twitchEmotes;

  // Twitch の emotes タグと同じコードポイント単位で位置を数えるため、コードポイント配列で走査する
  const codePoints = [...text];
  const merged = [...twitchEmotes];
  let tokenStart = -1;

  for (let i = 0; i <= codePoints.length; i += 1) {
    const isBoundary = i === codePoints.length || /\s/u.test(codePoints[i]);
    if (!isBoundary) {
      if (tokenStart === -1) tokenStart = i;
      continue;
    }
    if (tokenStart === -1) continue;

    const token = codePoints.slice(tokenStart, i).join("");
    const match = CHEERMOTE_TOKEN_PATTERN.exec(token);
    if (match !== null) {
      const prefix = match[1].toLowerCase();
      const amount = Number.parseInt(match[2], 10);
      if (
        GLOBAL_CHEERMOTE_PREFIXES.has(prefix) &&
        amount >= 1 &&
        !overlapsAnyEmote(tokenStart, i - 1, twitchEmotes)
      ) {
        // 画像が覆うのはプレフィックス部分だけ。bits 数は後続のテキストセグメントとして残る
        const prefixEnd = tokenStart + match[1].length - 1;
        merged.push({ id: `cheer:${prefix}/${resolveCheermoteTier(amount)}`, start: tokenStart, end: prefixEnd });
      }
    }
    tokenStart = -1;
  }

  merged.sort((a, b) => a.start - b.start);
  return merged;
}
