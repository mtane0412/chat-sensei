/**
 * src/lib/twitch/irc-parser.ts のテスト。
 *
 * Twitch IRC(WebSocket)から流れてくる生の行データを構造化する純関数群を検証する。
 * テストデータは、実際に `wss://irc-ws.chat.twitch.tv` へ匿名接続して観測した
 * 行フォーマットに準拠させている(タグ・プレフィックス・コマンド・パラメータの並び)。
 */
import { describe, expect, it } from "vitest";
import {
  parseBadgesTag,
  parseEmotesTag,
  parseIrcLine,
  parseTwitchIrcMessage,
} from "./irc-parser";

describe("parseIrcLine", () => {
  it("タグ・プレフィックス・コマンド・パラメータ・トレーリングを分解できる", () => {
    const line =
      "@badge-info=;badges=broadcaster/1;color=#FF0000;display-name=CodeChamp92;id=abc-123;user-id=987654 :codechamp92!codechamp92@codechamp92.tmi.twitch.tv PRIVMSG #zackrawrr :Hello chat, GG!";

    const parsed = parseIrcLine(line);

    expect(parsed.tags).toMatchObject({
      "badge-info": "",
      badges: "broadcaster/1",
      color: "#FF0000",
      "display-name": "CodeChamp92",
      id: "abc-123",
      "user-id": "987654",
    });
    expect(parsed.prefix).toBe("codechamp92!codechamp92@codechamp92.tmi.twitch.tv");
    expect(parsed.command).toBe("PRIVMSG");
    expect(parsed.params).toEqual(["#zackrawrr", "Hello chat, GG!"]);
  });

  it("タグもプレフィックスも無い PING 行を分解できる", () => {
    const parsed = parseIrcLine("PING :tmi.twitch.tv");

    expect(parsed.tags).toEqual({});
    expect(parsed.prefix).toBeNull();
    expect(parsed.command).toBe("PING");
    expect(parsed.params).toEqual(["tmi.twitch.tv"]);
  });

  it("IRCv3のエスケープシーケンス(\\s \\: \\\\)をタグ値から復元する", () => {
    const line = "@display-name=Code\\sChamp\\s92;note=a\\:b\\\\c :tmi.twitch.tv ROOMSTATE #ch";

    const parsed = parseIrcLine(line);

    expect(parsed.tags["display-name"]).toBe("Code Champ 92");
    expect(parsed.tags.note).toBe("a;b\\c");
  });

  it("末尾に孤立したバックスラッシュがある場合は無視する(仕様通り)", () => {
    const parsed = parseIrcLine("@note=abc\\ :tmi.twitch.tv ROOMSTATE #ch");

    expect(parsed.tags.note).toBe("abc");
  });
});

describe("parseEmotesTag", () => {
  it("空文字列の場合は空配列を返す", () => {
    expect(parseEmotesTag("")).toEqual([]);
  });

  it("同一emoteが複数箇所に出現する場合を出現順に並べて返す", () => {
    // "Kappa test Kappa" のような発言で emote id=25 が2箇所出現するケース
    const result = parseEmotesTag("25:0-4,11-15");

    expect(result).toEqual([
      { id: "25", start: 0, end: 4 },
      { id: "25", start: 11, end: 15 },
    ]);
  });

  it("複数種類のemoteが混在する場合も開始位置順に並べる", () => {
    const result = parseEmotesTag("25:11-15/1902:0-4");

    expect(result).toEqual([
      { id: "1902", start: 0, end: 4 },
      { id: "25", start: 11, end: 15 },
    ]);
  });
});

describe("parseBadgesTag", () => {
  it("空文字列の場合は空配列を返す", () => {
    expect(parseBadgesTag("")).toEqual([]);
  });

  it("複数バッジをname/versionの配列に変換する", () => {
    const result = parseBadgesTag("broadcaster/1,subscriber/12,premium/1");

    expect(result).toEqual([
      { name: "broadcaster", version: "1" },
      { name: "subscriber", version: "12" },
      { name: "premium", version: "1" },
    ]);
  });
});

describe("parseTwitchIrcMessage", () => {
  it("PRIVMSGを構造化されたチャットメッセージに変換する", () => {
    const line =
      "@badge-info=;badges=broadcaster/1,subscriber/12;color=#1E90FF;display-name=CodeChamp92;emotes=25:6-10;first-msg=0;id=msg-abc-123;mod=0;room-id=552120296;subscriber=1;tmi-sent-ts=1690000000123;turbo=0;user-id=987654 :codechamp92!codechamp92@codechamp92.tmi.twitch.tv PRIVMSG #zackrawrr :nice Kappa play";

    const event = parseTwitchIrcMessage(line);

    expect(event).toEqual({
      type: "privmsg",
      channel: "zackrawrr",
      message: {
        id: "msg-abc-123",
        channel: "zackrawrr",
        userId: "987654",
        username: "codechamp92",
        displayName: "CodeChamp92",
        color: "#1E90FF",
        text: "nice Kappa play",
        isAction: false,
        emotes: [{ id: "25", start: 6, end: 10 }],
        badges: [
          { name: "broadcaster", version: "1" },
          { name: "subscriber", version: "12" },
        ],
        timestampMs: 1690000000123,
      },
    });
  });

  it("display-name や color が無い匿名寄りのユーザーでも username にフォールバックする", () => {
    const line = "@badge-info=;badges=;emotes=;id=msg-2;user-id=111 :lurker42!lurker42@lurker42.tmi.twitch.tv PRIVMSG #zackrawrr :hi";

    const event = parseTwitchIrcMessage(line);

    expect(event.type).toBe("privmsg");
    if (event.type !== "privmsg") throw new Error("unreachable");
    expect(event.message.displayName).toBe("lurker42");
    expect(event.message.color).toBeNull();
  });

  it("/me による CTCP ACTION メッセージを isAction:true として解釈しテキストを剥がす", () => {
    const line =
      "@id=msg-3;user-id=222 :vibecoder!vibecoder@vibecoder.tmi.twitch.tv PRIVMSG #zackrawrr :ACTION waves hello";

    const event = parseTwitchIrcMessage(line);

    expect(event.type).toBe("privmsg");
    if (event.type !== "privmsg") throw new Error("unreachable");
    expect(event.message.isAction).toBe(true);
    expect(event.message.text).toBe("waves hello");
  });

  it("本文がたまたま'ACTION 'で始まるだけの通常発言は /me 扱いにしない(CTCPマーカーの制御文字が無いため)", () => {
    const line =
      "@id=msg-4;user-id=333 :moviefan!moviefan@moviefan.tmi.twitch.tv PRIVMSG #zackrawrr :ACTION movies are the best genre imo";

    const event = parseTwitchIrcMessage(line);

    expect(event.type).toBe("privmsg");
    if (event.type !== "privmsg") throw new Error("unreachable");
    expect(event.message.isAction).toBe(false);
    expect(event.message.text).toBe("ACTION movies are the best genre imo");
  });

  it("PING をそのまま payload 付きで返す", () => {
    const event = parseTwitchIrcMessage("PING :tmi.twitch.tv");

    expect(event).toEqual({ type: "ping", payload: "tmi.twitch.tv" });
  });

  it("ROOMSTATE をチャンネル設定として解釈する", () => {
    const line =
      "@emote-only=0;followers-only=1440;r9k=0;room-id=552120296;slow=0;subs-only=0 :tmi.twitch.tv ROOMSTATE #zackrawrr";

    const event = parseTwitchIrcMessage(line);

    expect(event).toEqual({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: 1440,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: "552120296",
      },
    });
  });

  it("対象ユーザー付きのCLEARCHAT(タイムアウト)を解釈する", () => {
    const line = "@ban-duration=600;room-id=552120296 :tmi.twitch.tv CLEARCHAT #zackrawrr :baduser99";

    const event = parseTwitchIrcMessage(line);

    expect(event).toEqual({
      type: "clearchat",
      channel: "zackrawrr",
      targetUsername: "baduser99",
      banDurationSeconds: 600,
    });
  });

  it("対象ユーザーが無いCLEARCHAT(チャット全消去)を解釈する", () => {
    const line = "@room-id=552120296 :tmi.twitch.tv CLEARCHAT #zackrawrr";

    const event = parseTwitchIrcMessage(line);

    expect(event).toEqual({
      type: "clearchat",
      channel: "zackrawrr",
      targetUsername: null,
      banDurationSeconds: null,
    });
  });

  it("NOTICE をチャンネルとメッセージ本文として解釈する", () => {
    const line = "@msg-id=msg_channel_suspended :tmi.twitch.tv NOTICE #zackrawrr :This channel does not exist or has been suspended.";

    const event = parseTwitchIrcMessage(line);

    expect(event).toEqual({
      type: "notice",
      channel: "zackrawrr",
      message: "This channel does not exist or has been suspended.",
      msgId: "msg_channel_suspended",
    });
  });

  it("RECONNECT をそのまま再接続要求として解釈する", () => {
    const event = parseTwitchIrcMessage(":tmi.twitch.tv RECONNECT");

    expect(event).toEqual({ type: "reconnect" });
  });

  it("未対応コマンド(例: 接続時のwelcome応答)は unknown として command を保持する", () => {
    const event = parseTwitchIrcMessage(":tmi.twitch.tv 001 justinfan39818 :Welcome, GLHF!");

    expect(event).toEqual({ type: "unknown", command: "001" });
  });
});
