/**
 * src/lib/twitch/irc-client.ts のテスト。
 *
 * 実際のWebSocket通信は行わず、`createWebSocket` に注入したフェイクの
 * WebSocket実装を通じて、接続シーケンス・PING応答・再接続(指数バックオフ)・
 * 明示的な切断による再接続停止を検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTwitchIrcClient, type WebSocketLike } from "./irc-client";
import type { TwitchChatEvent } from "./irc-parser";

/** テスト用のフェイクWebSocket。サーバー側の挙動(open/message/close)を手動で発火できる */
class FakeWebSocket implements WebSocketLike {
  url: string;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emitOpen() {
    this.onopen?.();
  }

  emitMessage(data: string) {
    this.onmessage?.({ data });
  }

  /** サーバー側から予期せず切断された状況を再現する(clientのclose()を経由しない) */
  emitUnexpectedClose() {
    this.onclose?.();
  }
}

describe("createTwitchIrcClient", () => {
  let createdSockets: FakeWebSocket[];
  let events: TwitchChatEvent[];
  let states: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    createdSockets = [];
    events = [];
    states = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeClient(randomSuffix: () => number = () => 12345) {
    return createTwitchIrcClient(
      {
        onEvent: (event) => events.push(event),
        onStateChange: (state) => states.push(state),
      },
      {
        createWebSocket: (url) => {
          const ws = new FakeWebSocket(url);
          createdSockets.push(ws);
          return ws;
        },
        randomSuffix,
      },
    );
  }

  it("接続時に正しいURLへ接続し、CAP要求・匿名NICK・JOINを送信する", () => {
    const client = makeClient();

    client.connect("SomeChannel");
    createdSockets[0]?.emitOpen();

    expect(createdSockets[0]?.url).toBe("wss://irc-ws.chat.twitch.tv:443");
    expect(createdSockets[0]?.sent).toEqual([
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "NICK justinfan12345",
      "JOIN #somechannel",
    ]);
    expect(states).toEqual(["connecting", "open"]);
  });

  it("PING を受信したら自動的に PONG を送信し、イベントとしては転送しない", () => {
    const client = makeClient();
    client.connect("somechannel");
    createdSockets[0]?.emitOpen();

    createdSockets[0]?.emitMessage("PING :tmi.twitch.tv\r\n");

    expect(createdSockets[0]?.sent).toContain("PONG :tmi.twitch.tv");
    expect(events).toEqual([]);
  });

  it("1フレームに複数行含まれる場合、それぞれをパースしてイベントとして順番に転送する", () => {
    const client = makeClient();
    client.connect("somechannel");
    createdSockets[0]?.emitOpen();

    const line1 =
      "@id=msg-1;user-id=1 :codechamp92!codechamp92@codechamp92.tmi.twitch.tv PRIVMSG #somechannel :hello";
    const line2 =
      "@id=msg-2;user-id=2 :lurker42!lurker42@lurker42.tmi.twitch.tv PRIVMSG #somechannel :gg";
    createdSockets[0]?.emitMessage(`${line1}\r\n${line2}\r\n`);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "privmsg", message: { text: "hello" } });
    expect(events[1]).toMatchObject({ type: "privmsg", message: { text: "gg" } });
  });

  it("予期しない切断が起きた場合、指数バックオフで再接続する", () => {
    const client = makeClient();
    client.connect("somechannel");
    createdSockets[0]?.emitOpen();

    createdSockets[0]?.emitUnexpectedClose();
    expect(states.at(-1)).toBe("reconnecting");
    expect(createdSockets).toHaveLength(1); // まだ再接続していない

    vi.advanceTimersByTime(999);
    expect(createdSockets).toHaveLength(1); // 初回待機(1000ms)未満ではまだ再接続しない

    vi.advanceTimersByTime(1);
    expect(createdSockets).toHaveLength(2); // 1000ms経過で再接続開始

    createdSockets[1]?.emitOpen();
    expect(createdSockets[1]?.sent).toEqual([
      "CAP REQ :twitch.tv/tags twitch.tv/commands",
      "NICK justinfan12345",
      "JOIN #somechannel",
    ]);

    // 2回目の切断では待機時間が倍(2000ms)になる
    createdSockets[1]?.emitUnexpectedClose();
    vi.advanceTimersByTime(1999);
    expect(createdSockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(createdSockets).toHaveLength(3);
  });

  it("明示的に disconnect() した場合は再接続しない", () => {
    const client = makeClient();
    client.connect("somechannel");
    createdSockets[0]?.emitOpen();

    client.disconnect();

    expect(createdSockets[0]?.closed).toBe(true);
    expect(states.at(-1)).toBe("closed");

    vi.advanceTimersByTime(60_000);
    expect(createdSockets).toHaveLength(1); // 再接続が走っていないこと
  });

  it("サーバーからの RECONNECT 通知を受けたら再接続する", () => {
    const client = makeClient();
    client.connect("somechannel");
    createdSockets[0]?.emitOpen();

    createdSockets[0]?.emitMessage(":tmi.twitch.tv RECONNECT\r\n");

    // RECONNECT要求はイベントとして転送せず、クライアント内部で再接続処理する
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(createdSockets).toHaveLength(2);
  });

  it("チャンネル名を切り替えて connect() し直すと新しい接続で新チャンネルにJOINする", () => {
    const client = makeClient();
    client.connect("firstchannel");
    createdSockets[0]?.emitOpen();

    client.connect("secondchannel");

    expect(createdSockets[0]?.closed).toBe(true);
    expect(createdSockets).toHaveLength(2);
    createdSockets[1]?.emitOpen();
    expect(createdSockets[1]?.sent).toContain("JOIN #secondchannel");
  });
});
