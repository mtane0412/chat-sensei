/**
 * Twitch IRC(`wss://irc-ws.chat.twitch.tv`)から届く生の行データを構造化する純関数群。
 *
 * Twitch は IRCv3 に `tags` capability を加えたプロトコルでチャットを配信する。
 * ここでは通信そのものは扱わず、1行のテキストを受け取って構造化データへ変換する
 * ことだけに責務を絞る(WebSocket接続・再接続は `irc-client.ts` が担う)。
 *
 * 参考: https://dev.twitch.tv/docs/chat/irc/
 */

/** IRCv3 タグ(`@key=value;key2=value2`)をキー・値のレコードにしたもの */
export type IrcTags = Record<string, string>;

/** 1行のIRCメッセージを構文解析しただけの、プロトコル層の構造体 */
export interface ParsedIrcMessage {
  raw: string;
  tags: IrcTags;
  /** `:nick!user@host` や `:tmi.twitch.tv` の部分。存在しない行は null */
  prefix: string | null;
  command: string;
  params: string[];
}

/** Twitch の emotes タグ(`id:start-end,start-end/id2:start-end`)を展開した1件分 */
export interface EmotePosition {
  id: string;
  /** メッセージ本文中の開始文字インデックス(0始まり、UTF-16コードユニット基準) */
  start: number;
  /** 終了文字インデックス(inclusive) */
  end: number;
}

/** Twitch の badges タグ(`name/version,name2/version2`)を展開した1件分 */
export interface Badge {
  name: string;
  version: string;
}

/** チャット欄に表示する1メッセージ分の構造化データ */
export interface TwitchChatMessage {
  /** タグの `id`。再接続時の重複排除などに使う。取得できない場合は null */
  id: string | null;
  /** 先頭の `#` を除いたチャンネル名 */
  channel: string;
  userId: string | null;
  /** ログイン名(小文字・英数字)。prefix から取得できない場合は空文字 */
  username: string;
  /** 表示名。`display-name` タグが無ければ username にフォールバックする */
  displayName: string;
  /** チャット名の表示色(例: `#1E90FF`)。未設定の視聴者は null */
  color: string | null;
  /** CTCP ACTION の装飾(`\x01ACTION ... \x01`)を剥がした本文 */
  text: string;
  /** `/me` コマンドによる発言かどうか */
  isAction: boolean;
  emotes: EmotePosition[];
  badges: Badge[];
  /** `bits` タグ(Cheer した bits の合計)。Cheer していない発言は null */
  bits: number | null;
  /** `tmi-sent-ts` をミリ秒のUNIXタイムスタンプとして解釈した値。無ければ null */
  timestampMs: number | null;
}

/** Twitch IRC のチャンネル設定(ROOMSTATE) */
export interface RoomState {
  emoteOnly: boolean;
  /**
   * フォロー限定チャットの設定(分)。Twitchの仕様上 `-1` は無効化を意味するが、
   * ここでは呼び出し側が意味を判断できるよう生の数値のまま保持する。
   */
  followersOnlyMinutes: number | null;
  r9k: boolean;
  slowSeconds: number;
  subsOnly: boolean;
  /** `room-id` タグ(配信者の Twitch ユーザー ID)。サードパーティ emote の取得に使う。無ければ null */
  roomId: string | null;
}

/** parseTwitchIrcMessage が返す、UI層がそのまま扱える構造化イベント */
export type TwitchChatEvent =
  | { type: "ping"; payload: string }
  | { type: "privmsg"; channel: string; message: TwitchChatMessage }
  | { type: "roomstate"; channel: string; state: RoomState }
  | { type: "clearchat"; channel: string; targetUsername: string | null; banDurationSeconds: number | null }
  | { type: "notice"; channel: string; message: string; msgId: string | null }
  | { type: "reconnect" }
  | { type: "unknown"; command: string };

/**
 * IRCv3 タグ値のエスケープシーケンス(`\s` `\:` `\\` `\r` `\n`)を復元する。
 * 未知のエスケープはバックスラッシュを除去して次の文字をそのまま残し、
 * 末尾に孤立したバックスラッシュがある場合は仕様通り無視する。
 */
function unescapeTagValue(value: string): string {
  let result = "";
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === "\\") {
      if (i + 1 >= value.length) {
        break; // 末尾の孤立したバックスラッシュは無視する
      }
      const next = value[i + 1];
      switch (next) {
        case "s":
          result += " ";
          break;
        case ":":
          result += ";";
          break;
        case "\\":
          result += "\\";
          break;
        case "r":
          result += "\r";
          break;
        case "n":
          result += "\n";
          break;
        default:
          result += next;
          break;
      }
      i += 2;
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

/** IRCv3 の1行を `{tags, prefix, command, params}` に構文解析する(Twitch固有の意味付けはしない) */
export function parseIrcLine(line: string): ParsedIrcMessage {
  let rest = line;
  const tags: IrcTags = {};

  if (rest.startsWith("@")) {
    const spaceIdx = rest.indexOf(" ");
    const tagsPart = spaceIdx === -1 ? rest.slice(1) : rest.slice(1, spaceIdx);
    rest = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
    for (const pair of tagsPart.split(";")) {
      if (!pair) continue;
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        tags[pair] = "";
      } else {
        tags[pair.slice(0, eqIdx)] = unescapeTagValue(pair.slice(eqIdx + 1));
      }
    }
  }

  let prefix: string | null = null;
  if (rest.startsWith(":")) {
    const spaceIdx = rest.indexOf(" ");
    prefix = spaceIdx === -1 ? rest.slice(1) : rest.slice(1, spaceIdx);
    rest = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1);
  }

  const trailingSepIdx = rest.indexOf(" :");
  let paramsPart: string;
  let trailing: string | null = null;
  if (trailingSepIdx !== -1) {
    paramsPart = rest.slice(0, trailingSepIdx);
    trailing = rest.slice(trailingSepIdx + 2);
  } else {
    paramsPart = rest;
  }

  const words = paramsPart.split(" ").filter((w) => w.length > 0);
  const command = words[0] ?? "";
  const params = words.slice(1);
  if (trailing !== null) {
    params.push(trailing);
  }

  return { raw: line, tags, prefix, command, params };
}

/** `:nick!user@host` 形式のプレフィックスからログイン名(nick)を取り出す。サーバー由来のプレフィックスは null */
function parsePrefixNick(prefix: string | null): string | null {
  if (!prefix) return null;
  const bangIdx = prefix.indexOf("!");
  if (bangIdx === -1) return null;
  return prefix.slice(0, bangIdx);
}

/** 先頭の `#` を取り除いたチャンネル名を返す */
function stripChannelHash(channelParam: string | undefined): string {
  return (channelParam ?? "").replace(/^#/, "");
}

/** Twitch の emotes タグを、出現位置(start)昇順の一覧に変換する */
export function parseEmotesTag(value: string): EmotePosition[] {
  if (!value) return [];
  const result: EmotePosition[] = [];
  for (const part of value.split("/")) {
    const [id, positions] = part.split(":");
    if (!id || !positions) continue;
    for (const range of positions.split(",")) {
      const [startStr, endStr] = range.split("-");
      const start = Number.parseInt(startStr, 10);
      const end = Number.parseInt(endStr, 10);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      result.push({ id, start, end });
    }
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

/** Twitch の badges タグを `{name, version}` の一覧に変換する */
export function parseBadgesTag(value: string): Badge[] {
  if (!value) return [];
  return value
    .split(",")
    .filter((part) => part.length > 0)
    .map((part) => {
      const [name, version] = part.split("/");
      return { name: name ?? "", version: version ?? "" };
    });
}

/** CTCP ACTION(`\x01ACTION 本文\x01`, `/me` コマンドの実体)の装飾を剥がす */
function stripActionWrapper(rawText: string): { text: string; isAction: boolean } {
  const ACTION_PREFIX = "ACTION ";
  const ACTION_SUFFIX = "";
  if (rawText.startsWith(ACTION_PREFIX) && rawText.endsWith(ACTION_SUFFIX)) {
    return { text: rawText.slice(ACTION_PREFIX.length, rawText.length - ACTION_SUFFIX.length), isAction: true };
  }
  return { text: rawText, isAction: false };
}

function parsePrivmsg(parsed: ParsedIrcMessage): TwitchChatEvent {
  const channel = stripChannelHash(parsed.params[0]);
  const { text, isAction } = stripActionWrapper(parsed.params[1] ?? "");
  const username = parsePrefixNick(parsed.prefix) ?? "";

  return {
    type: "privmsg",
    channel,
    message: {
      id: parsed.tags.id ?? null,
      channel,
      userId: parsed.tags["user-id"] ?? null,
      username,
      displayName: parsed.tags["display-name"] || username,
      color: parsed.tags.color || null,
      text,
      isAction,
      emotes: parseEmotesTag(parsed.tags.emotes ?? ""),
      badges: parseBadgesTag(parsed.tags.badges ?? ""),
      bits: parsed.tags.bits ? Number.parseInt(parsed.tags.bits, 10) : null,
      timestampMs: parsed.tags["tmi-sent-ts"] ? Number.parseInt(parsed.tags["tmi-sent-ts"], 10) : null,
    },
  };
}

function parseRoomState(parsed: ParsedIrcMessage): TwitchChatEvent {
  const followersOnlyRaw = parsed.tags["followers-only"];
  const slowRaw = parsed.tags.slow;
  return {
    type: "roomstate",
    channel: stripChannelHash(parsed.params[0]),
    state: {
      emoteOnly: parsed.tags["emote-only"] === "1",
      followersOnlyMinutes: followersOnlyRaw !== undefined ? Number.parseInt(followersOnlyRaw, 10) : null,
      r9k: parsed.tags.r9k === "1",
      slowSeconds: slowRaw !== undefined ? Number.parseInt(slowRaw, 10) : 0,
      subsOnly: parsed.tags["subs-only"] === "1",
      roomId: parsed.tags["room-id"] ?? null,
    },
  };
}

function parseClearChat(parsed: ParsedIrcMessage): TwitchChatEvent {
  const banDurationRaw = parsed.tags["ban-duration"];
  return {
    type: "clearchat",
    channel: stripChannelHash(parsed.params[0]),
    targetUsername: parsed.params[1] || null,
    banDurationSeconds: banDurationRaw !== undefined ? Number.parseInt(banDurationRaw, 10) : null,
  };
}

function parseNotice(parsed: ParsedIrcMessage): TwitchChatEvent {
  return {
    type: "notice",
    channel: stripChannelHash(parsed.params[0]),
    message: parsed.params[1] ?? "",
    msgId: parsed.tags["msg-id"] ?? null,
  };
}

/**
 * Twitch IRC の1行を、UIやクライアントがそのまま扱える `TwitchChatEvent` に変換する。
 * 対応していないコマンド(接続直後の numeric reply など)は `unknown` として
 * コマンド名だけを保持し、内容を握りつぶさない。
 */
export function parseTwitchIrcMessage(line: string): TwitchChatEvent {
  const parsed = parseIrcLine(line);

  switch (parsed.command) {
    case "PING":
      return { type: "ping", payload: parsed.params[0] ?? "" };
    case "PRIVMSG":
      return parsePrivmsg(parsed);
    case "ROOMSTATE":
      return parseRoomState(parsed);
    case "CLEARCHAT":
      return parseClearChat(parsed);
    case "NOTICE":
      return parseNotice(parsed);
    case "RECONNECT":
      return { type: "reconnect" };
    default:
      return { type: "unknown", command: parsed.command };
  }
}
