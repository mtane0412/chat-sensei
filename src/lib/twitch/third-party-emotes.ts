/**
 * サードパーティ emote(BTTV / FrankerFaceZ / 7TV)への対応。
 *
 * Twitch 公式 emote は IRC の `emotes` タグで位置が届くが、サードパーティ emote は
 * 本文に emote 名がそのまま含まれるだけで、位置情報は届かない。そこで:
 *
 * 1. `fetchThirdPartyEmoteMap` — 各サービスの公開 API からグローバル emote と
 *    チャンネル emote(配信者の Twitch ID で引く)を集め、「emote 名 → プレフィックス付き ID」の
 *    対応表を作る。プレフィックス(`bttv:` / `ffz:` / `7tv:`)は `emotes.ts` の
 *    `buildEmoteImageUrl` が CDN URL の組み立てに使う
 * 2. `mergeThirdPartyEmotePositions` — 発言本文を空白区切りの単語に分け、対応表と
 *    完全一致した単語を `EmotePosition` として Twitch 公式 emote の位置情報に合成する。
 *    これにより下流(描画・翻訳のプレースホルダ化・Pick up の除外・textless 判定)は
 *    既存の emote 処理をそのまま使える
 *
 * 位置はTwitch の `emotes` タグと同じくコードポイント単位・end は inclusive で表す
 * (`emotes.ts` の `splitMessageIntoSegments` が UTF-16 位置へ変換する)。
 * emote 名の照合は各サービスの仕様どおり大文字小文字を区別する。
 */
import type { EmotePosition } from "./irc-parser";

/** サードパーティ emote 1 件。`id` は `bttv:` / `ffz:` / `7tv:` プレフィックス付き */
export interface ThirdPartyEmote {
  /** チャット本文中に現れる emote 名(例: `catJAM`) */
  code: string;
  /** プロバイダのプレフィックスを付けた emote ID(例: `bttv:60ae958e229664e8667aea38`) */
  id: string;
}

/**
 * emote 一覧から「emote 名 → プレフィックス付き ID」の対応表を作る。
 * 同名の emote は後勝ちとする(呼び出し側がグローバル → チャンネルの順で渡すことで、
 * チャンネル emote がグローバル emote を上書きする)。
 */
export function buildThirdPartyEmoteMap(emotes: ThirdPartyEmote[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const emote of emotes) {
    map.set(emote.code, emote.id);
  }
  return map;
}

/** Twitch 公式 emote の位置範囲と単語の範囲(いずれもコードポイント単位・inclusive)が重なるか */
function overlapsAnyTwitchEmote(start: number, end: number, twitchEmotes: EmotePosition[]): boolean {
  return twitchEmotes.some((emote) => start <= emote.end && end >= emote.start);
}

/**
 * 発言本文の空白区切りの単語を対応表と照合し、一致した単語をサードパーティ emote の
 * `EmotePosition` として Twitch 公式 emote の位置情報に合成して返す(開始位置の昇順)。
 *
 * - 単語全体が emote 名と完全一致した場合のみ emote とする(`catJAM!` のような部分一致は対象外)
 * - Twitch 公式 emote の範囲と重なる単語は公式 emote を優先して対象外とする
 */
export function mergeThirdPartyEmotePositions(
  text: string,
  twitchEmotes: EmotePosition[],
  emoteMap: ReadonlyMap<string, string>,
): EmotePosition[] {
  if (emoteMap.size === 0) return twitchEmotes;

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
    const end = i - 1;
    const id = emoteMap.get(token);
    if (id !== undefined && !overlapsAnyTwitchEmote(tokenStart, end, twitchEmotes)) {
      merged.push({ id, start: tokenStart, end });
    }
    tokenStart = -1;
  }

  merged.sort((a, b) => a.start - b.start);
  return merged;
}

/** BTTV API の emote 1 件(`/3/cached/emotes/global` と `/3/cached/users/twitch/:id` で共通の形) */
interface BttvEmoteJson {
  id: string;
  code: string;
}

/** 値が BTTV emote の形かを確かめる型ガード。API 側の仕様変更で形が変わった項目は読み飛ばす */
function isBttvEmoteJson(value: unknown): value is BttvEmoteJson {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.code === "string";
}

/** BTTV のグローバル emote(emote の配列)を解析する */
function parseBttvEmoteList(json: unknown): ThirdPartyEmote[] {
  if (!Array.isArray(json)) return [];
  return json.filter(isBttvEmoteJson).map((emote) => ({ code: emote.code, id: `bttv:${emote.id}` }));
}

/** BTTV のチャンネル emote(`channelEmotes` + `sharedEmotes`)を解析する */
function parseBttvUser(json: unknown): ThirdPartyEmote[] {
  if (typeof json !== "object" || json === null) return [];
  const record = json as Record<string, unknown>;
  return [...parseBttvEmoteList(record.channelEmotes), ...parseBttvEmoteList(record.sharedEmotes)];
}

/**
 * FFZ の emote 一覧を解析する。BTTV が提供する FFZ のキャッシュ API
 * (`/3/cached/frankerfacez/...`)を使うため、`id` は数値・emote 名は `code` で届く
 */
function parseFfzEmoteList(json: unknown): ThirdPartyEmote[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "number" || typeof record.code !== "string") return [];
    return [{ code: record.code, id: `ffz:${record.id}` }];
  });
}

/** 7TV の emote 一覧(`{id, name}` の配列)を解析する */
function parseSevenTvEmoteList(json: unknown): ThirdPartyEmote[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const record = value as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string") return [];
    return [{ code: record.name, id: `7tv:${record.id}` }];
  });
}

/** 7TV のグローバル emote セット(`{emotes: [...]}`)を解析する */
function parseSevenTvEmoteSet(json: unknown): ThirdPartyEmote[] {
  if (typeof json !== "object" || json === null) return [];
  return parseSevenTvEmoteList((json as Record<string, unknown>).emotes);
}

/** 7TV のユーザー情報(`{emote_set: {emotes: [...]}}`)を解析する */
function parseSevenTvUser(json: unknown): ThirdPartyEmote[] {
  if (typeof json !== "object" || json === null) return [];
  return parseSevenTvEmoteSet((json as Record<string, unknown>).emote_set);
}

/** 読み込む API エンドポイントと、そのレスポンスの解析関数の組 */
interface EmoteSource {
  url: string;
  parse: (json: unknown) => ThirdPartyEmote[];
}

/**
 * 優先度の昇順(後勝ち)に並べた emote の取得元一覧。
 * グローバル → チャンネルの順、各スコープ内は FFZ → BTTV → 7TV の順とし、
 * 同名の emote はチャンネル emote(その中では 7TV)が最優先になる。
 */
function buildEmoteSources(twitchUserId: string): EmoteSource[] {
  return [
    { url: "https://api.betterttv.net/3/cached/frankerfacez/emotes/global", parse: parseFfzEmoteList },
    { url: "https://api.betterttv.net/3/cached/emotes/global", parse: parseBttvEmoteList },
    { url: "https://7tv.io/v3/emote-sets/global", parse: parseSevenTvEmoteSet },
    { url: `https://api.betterttv.net/3/cached/frankerfacez/users/twitch/${twitchUserId}`, parse: parseFfzEmoteList },
    { url: `https://api.betterttv.net/3/cached/users/twitch/${twitchUserId}`, parse: parseBttvUser },
    { url: `https://7tv.io/v3/users/twitch/${twitchUserId}`, parse: parseSevenTvUser },
  ];
}

/**
 * BTTV / FFZ / 7TV のグローバル・チャンネル emote をすべて取得し、
 * 「emote 名 → プレフィックス付き ID」の対応表を返す。
 *
 * 取得元ごとの失敗は当該取得元を空として続行する(暗黙のフォールバックではなく意図した仕様):
 * - そのサービスに登録していないチャンネルでは API が 404 を返す(正常系)
 * - 一部の外部サービスの障害で、他のサービスの emote 表示まで失われるべきではない
 */
export async function fetchThirdPartyEmoteMap(
  twitchUserId: string,
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, string>> {
  const results = await Promise.all(
    buildEmoteSources(twitchUserId).map(async (source): Promise<ThirdPartyEmote[]> => {
      try {
        const response = await fetchFn(source.url);
        if (!response.ok) return [];
        return source.parse(await response.json());
      } catch (error) {
        console.warn(`サードパーティ emote の取得に失敗しました: ${source.url}`, error);
        return [];
      }
    }),
  );
  return buildThirdPartyEmoteMap(results.flat());
}
