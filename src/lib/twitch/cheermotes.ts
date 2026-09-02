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
 * Cheermote の一覧(`CheermoteSet`)は Helix の Cheermotes API
 * (`GET /bits/cheermotes?broadcaster_id=`)を Next.js プロキシ(`/api/twitch/`)経由で
 * 取得する(`fetchCheermoteSet`)。これによりグローバル Cheermote に加えて
 * チャンネル独自 Cheermote にも対応し、CDN 側の変化(BibleThump / EleGiggle の
 * 画像消失のような事象)にも自動追従する(issue #53)。
 *
 * Helix が利用できない場合(環境変数未設定の 503・障害など)は、グローバル Cheermote の
 * 静的一覧 `STATIC_CHEERMOTE_SET` にフォールバックする(意図した仕様。
 * 読み込みの流れとフォールバックの保持は `src/store/cheermotes.ts` が担う)。
 *
 * - emote 位置はプレフィックス部分だけを覆い、bits 数はテキストとして残す
 *   (Twitch 本家のチャット UI と同じく「画像 + 数値」で表示するため)
 * - ID は `cheer:{プレフィックス小文字}/{ティアの min_bits}` 形式とし、`emotes.ts` の
 *   `buildEmoteImageUrl` が画像 URL に解決する(API 取得済みならレジストリの URL、
 *   未取得なら静的 CDN URL)
 * - 位置は Twitch の `emotes` タグと同じくコードポイント単位・end は inclusive
 */
import type { EmotePosition } from "./irc-parser";

/** Cheermote の 1 ティア(bits 数の閾値と、その段階の画像 URL) */
export interface CheermoteTier {
  /** このティアが適用される最小の bits 数(Helix の `min_bits`) */
  minBits: number;
  /** このティアの画像 URL(ダーク・アニメ・2倍) */
  imageUrl: string;
}

/** プレフィックス(小文字)→ ティア一覧(minBits の降順)の対応表 */
export type CheermoteSet = ReadonlyMap<string, readonly CheermoteTier[]>;

/**
 * グローバル Cheermote のプレフィックス一覧(小文字)。
 * Helix が利用できない場合のフォールバック(`STATIC_CHEERMOTE_SET`)にのみ使う。
 * 出典: https://dev.twitch.tv/docs/irc/emotes/(Cheermotes の節)
 * BibleThump / EleGiggle は CDN 上に画像が存在しなくなっているため除外した(2026-09 に確認)。
 */
const GLOBAL_CHEERMOTE_PREFIXES: readonly string[] = [
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
];

/** グローバル Cheermote に共通のティア閾値(降順) */
const STATIC_CHEERMOTE_TIERS = [10000, 5000, 1000, 100, 1] as const;

/** 静的 CDN の Cheermote 画像 URL(ダーク・アニメ・2倍)を組み立てる */
function buildStaticCheermoteImageUrl(prefix: string, minBits: number): string {
  return `https://d3aqoihi2n8ty8.cloudfront.net/actions/${prefix}/dark/animated/${minBits}/2.gif`;
}

/**
 * Helix が利用できない場合のフォールバック用の静的な Cheermote 一覧。
 * グローバル Cheermote のみを含み、画像 URL は静的 CDN の URL を使う。
 */
export const STATIC_CHEERMOTE_SET: CheermoteSet = new Map(
  GLOBAL_CHEERMOTE_PREFIXES.map((prefix) => [
    prefix,
    STATIC_CHEERMOTE_TIERS.map((minBits) => ({
      minBits,
      imageUrl: buildStaticCheermoteImageUrl(prefix, minBits),
    })),
  ]),
);

/**
 * bits 数に応じた表示ティア(画像・色の段階)を返す。
 * ティア一覧(minBits の降順)から「bits 数以下で最大の minBits」のティアを選ぶ。
 * 最小ティアに満たない bits 数(チャンネル独自 Cheermote の最低 bits 未満など)は null。
 */
export function resolveCheermoteTier(bits: number, tiers: readonly CheermoteTier[]): CheermoteTier | null {
  for (const tier of tiers) {
    if (bits >= tier.minBits) return tier;
  }
  return null;
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
 *   (`cheermotes` のキーが小文字なので、トークン側を小文字化して引く)
 * - 単語全体が「プレフィックス + 1 以上の数値」で、bits 数が最小ティア以上の場合のみ Cheermote とする
 * - emote 位置はプレフィックス部分だけを覆い、bits 数はテキストとして残す
 * - 公式 emote の範囲と重なる単語は公式 emote を優先して対象外とする
 */
export function mergeCheermotePositions(
  text: string,
  twitchEmotes: EmotePosition[],
  bits: number | null,
  cheermotes: CheermoteSet,
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
      const tiers = cheermotes.get(prefix);
      const tier = tiers !== undefined && amount >= 1 ? resolveCheermoteTier(amount, tiers) : null;
      if (tier !== null && !overlapsAnyEmote(tokenStart, i - 1, twitchEmotes)) {
        // 画像が覆うのはプレフィックス部分だけ。bits 数は後続のテキストセグメントとして残る
        const prefixEnd = tokenStart + match[1].length - 1;
        merged.push({ id: `cheer:${prefix}/${tier.minBits}`, start: tokenStart, end: prefixEnd });
      }
    }
    tokenStart = -1;
  }

  merged.sort((a, b) => a.start - b.start);
  return merged;
}

/**
 * CheermoteSet から「emote ID の `cheer:` 以降(`プレフィックス/ティア`)→ 画像 URL」の
 * 対応表を作る。`emotes.ts` の `registerCheermoteImageUrls` に渡し、
 * `buildEmoteImageUrl` が API 由来の画像 URL を返せるようにする。
 */
export function buildCheermoteImageUrlMap(cheermotes: CheermoteSet): Map<string, string> {
  const map = new Map<string, string>();
  for (const [prefix, tiers] of cheermotes) {
    for (const tier of tiers) {
      map.set(`${prefix}/${tier.minBits}`, tier.imageUrl);
    }
  }
  return map;
}

/** Helix の Cheermotes API のティア 1 件から CheermoteTier を組み立てる。形式が想定と異なる場合は null */
function parseCheermoteTier(value: unknown): CheermoteTier | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.min_bits !== "number") return null;

  // 画像はダーク・アニメ・2倍を使う(既存の静的 CDN URL と同じ表示条件)
  const images = record.images as Record<string, unknown> | undefined;
  const dark = (images?.dark ?? null) as Record<string, unknown> | null;
  const animated = (dark?.animated ?? null) as Record<string, unknown> | null;
  const imageUrl = animated?.["2"];
  if (typeof imageUrl !== "string") return null;

  return { minBits: record.min_bits, imageUrl };
}

/**
 * Helix の Cheermotes API レスポンス(`{data: [{prefix, tiers: [...]}]}`)を解析して
 * CheermoteSet を作る。API 側の仕様変更などで形式が想定と異なる項目は読み飛ばす。
 * ティアは minBits の降順に並べる(`resolveCheermoteTier` が先頭から照合するため)。
 */
export function parseCheermoteSet(json: unknown): CheermoteSet {
  const set = new Map<string, readonly CheermoteTier[]>();
  if (typeof json !== "object" || json === null) return set;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data)) return set;

  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.prefix !== "string" || !Array.isArray(record.tiers)) continue;

    const tiers = record.tiers
      .map(parseCheermoteTier)
      .filter((tier): tier is CheermoteTier => tier !== null)
      .sort((a, b) => b.minBits - a.minBits);
    if (tiers.length === 0) continue;

    set.set(record.prefix.toLowerCase(), tiers);
  }
  return set;
}

/**
 * Helix プロキシ(`/api/twitch/bits/cheermotes`)から、指定した配信者の
 * Cheermote 一覧(グローバル + チャンネル独自)を取得する。
 *
 * 取得できない場合は null を返す(呼び出し側の `src/store/cheermotes.ts` が
 * 静的一覧 `STATIC_CHEERMOTE_SET` へフォールバックする。意図した仕様):
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害などの HTTP エラー
 * - ネットワークエラー
 * - Cheermote が 1 件も解析できないレスポンス(グローバル Cheermote は常に存在するはずのため異常とみなす)
 */
export async function fetchCheermoteSet(
  broadcasterId: string,
  fetchFn: typeof fetch = fetch,
): Promise<CheermoteSet | null> {
  try {
    const response = await fetchFn(
      `/api/twitch/bits/cheermotes?broadcaster_id=${encodeURIComponent(broadcasterId)}`,
    );
    if (!response.ok) {
      console.warn(`Cheermote 一覧の取得に失敗しました(HTTP ${response.status})。静的一覧を使います`);
      return null;
    }
    const set = parseCheermoteSet(await response.json());
    if (set.size === 0) {
      console.warn("Cheermote 一覧のレスポンスを解析できませんでした。静的一覧を使います");
      return null;
    }
    return set;
  } catch (error) {
    console.warn("Cheermote 一覧の取得に失敗しました。静的一覧を使います", error);
    return null;
  }
}
