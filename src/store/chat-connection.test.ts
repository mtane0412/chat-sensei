/**
 * src/store/chat-connection.ts(チャット接続の永続ストア)のテスト。
 *
 * ページ遷移(/deck・/study・/settingsへの移動)は Home コンポーネントの
 * アンマウントを引き起こすため、接続状態・受信済み発言をコンポーネントの
 * ローカル state / ref に持たせると、そのたびに Twitch IRC への WebSocket
 * 接続そのものが失われてしまう(コンポーネントのアンマウントで唯一の参照が
 * 消え、GC対象になるため)。
 *
 * このストアはモジュールスコープの Zustand ストアとして接続状態・発言一覧を
 * 保持することで、どのページが表示されていても接続が維持されることを保証する。
 * ここでは実際の WebSocket 通信を行わず、`createTwitchIrcClient` をモックして
 * ストア単体の振る舞いを検証する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TwitchIrcClientCallbacks } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
let capturedCallbacks: TwitchIrcClientCallbacks | null = null;

vi.mock("@/lib/twitch/irc-client", () => ({
  createTwitchIrcClient: vi.fn((callbacks: TwitchIrcClientCallbacks) => {
    capturedCallbacks = callbacks;
    return {
      connect: mockConnect,
      disconnect: mockDisconnect,
      getState: () => "idle",
    };
  }),
  // 実装(irc-client.ts)と同じ正規化ロジックをテストでも使う(チャンネル名の小文字化・#除去)
  normalizeChannelName: (channel: string) => channel.replace(/^#/, "").toLowerCase(),
}));

import { resetBotFilterStoreForTests, useBotFilterStore } from "./bot-filter";
import { resetChatConnectionStoreForTests, subscribeToChatMessages, useChatConnectionStore } from "./chat-connection";

/** テスト用のサンプル発言(実況チャットにありそうな「ナイスプレー」の一言) */
function createSampleMessage(overrides: Partial<TwitchChatMessage> = {}): TwitchChatMessage {
  return {
    id: "msg-1",
    channel: "somechannel",
    userId: "987654",
    username: "codechamp92",
    displayName: "CodeChamp92",
    color: "#1E90FF",
    text: "nice play chat",
    isAction: false,
    emotes: [],
    badges: [],
    timestampMs: 1690000000000,
    ...overrides,
  };
}

beforeEach(() => {
  // モジュールスコープのストアはテスト間で共有されるため、各テストの前に初期状態へ戻す
  resetChatConnectionStoreForTests();
  resetBotFilterStoreForTests();
});

afterEach(() => {
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  window.localStorage.clear();
});

describe("useChatConnectionStore", () => {
  it("connect()を呼ぶと、TwitchIrcClientのconnect()にチャンネル名がそのまま渡される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockConnect).toHaveBeenCalledWith("ZackRawrr");
  });

  it("connect()を呼ぶと、直前までの発言一覧がクリアされる", () => {
    useChatConnectionStore.setState({ messages: [createSampleMessage()] });

    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(useChatConnectionStore.getState().messages).toEqual([]);
  });

  it("disconnect()を呼ぶと、TwitchIrcClientのdisconnect()が呼ばれる", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    useChatConnectionStore.getState().disconnect();

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("connect()を呼ぶと、配信embed用に正規化(小文字化)したチャンネル名がchannelに保持される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(useChatConnectionStore.getState().channel).toBe("zackrawrr");
  });

  it("disconnect()を呼ぶと、channelがnullに戻る", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    useChatConnectionStore.getState().disconnect();

    expect(useChatConnectionStore.getState().channel).toBeNull();
  });

  it("クライアントからonStateChangeが通知されると、connectionStateが更新される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onStateChange?.("open");

    expect(useChatConnectionStore.getState().connectionState).toBe("open");
  });

  it("privmsgイベントを受信すると、messagesに追加される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");
    const message = createSampleMessage();

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message });

    expect(useChatConnectionStore.getState().messages).toEqual([message]);
  });

  it("表示上限(300件)を超えると、古い発言から破棄される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    for (let i = 0; i < 305; i += 1) {
      capturedCallbacks?.onEvent({
        type: "privmsg",
        channel: "somechannel",
        message: createSampleMessage({ id: `msg-${i}`, text: `message ${i}` }),
      });
    }

    const { messages } = useChatConnectionStore.getState();
    expect(messages).toHaveLength(300);
    expect(messages[0].text).toBe("message 5");
    expect(messages[299].text).toBe("message 304");
  });
});

describe("subscribeToChatMessages", () => {
  it("登録したリスナーは受信したprivmsgイベントのメッセージで呼ばれる", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");
    const listener = vi.fn();
    subscribeToChatMessages(listener);
    const message = createSampleMessage();

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message });

    expect(listener).toHaveBeenCalledWith(message);
  });

  it("unsubscribe()を呼んだ後は、リスナーが呼ばれなくなる", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");
    const listener = vi.fn();
    const unsubscribe = subscribeToChatMessages(listener);
    unsubscribe();

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message: createSampleMessage() });

    expect(listener).not.toHaveBeenCalled();
  });

  it("privmsg以外のイベント(ping等)ではリスナーは呼ばれない", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");
    const listener = vi.fn();
    subscribeToChatMessages(listener);

    capturedCallbacks?.onEvent({ type: "ping", payload: "PING :tmi.twitch.tv" });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("bot除外", () => {
  it("除外パターンに一致するユーザー名の発言は、messagesにもリスナーにも流れない", () => {
    useBotFilterStore.getState().setPatterns(["nightbot", "*trans"]);
    useChatConnectionStore.getState().connect("ZackRawrr");
    const listener = vi.fn();
    subscribeToChatMessages(listener);

    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: createSampleMessage({ id: "bot-1", username: "nightbot", displayName: "Nightbot" }),
    });
    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: createSampleMessage({ id: "bot-2", username: "yuki_trans", displayName: "yuki_trans" }),
    });
    const humanMessage = createSampleMessage({ id: "human-1", username: "viewer_taro" });
    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message: humanMessage });

    expect(useChatConnectionStore.getState().messages).toEqual([humanMessage]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(humanMessage);
  });

  it("除外パターンを変更すると、表示中の発言からも一致するものが取り除かれる", () => {
    useBotFilterStore.getState().setPatterns([]);
    const botMessage = createSampleMessage({ id: "bot-1", username: "streamelements" });
    const humanMessage = createSampleMessage({ id: "human-1", username: "viewer_taro" });
    useChatConnectionStore.setState({ messages: [botMessage, humanMessage] });

    useBotFilterStore.getState().setPatterns(["streamelements"]);

    expect(useChatConnectionStore.getState().messages).toEqual([humanMessage]);
  });
});
