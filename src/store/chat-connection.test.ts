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

// サードパーティ emote の読み込みは実 API を呼ぶため、ストア連携だけをモックで検証する
const mockLoadThirdPartyEmotes = vi.fn();
const mockClearThirdPartyEmotes = vi.fn();
let fakeThirdPartyEmoteMap = new Map<string, string>();

vi.mock("./third-party-emotes", () => ({
  loadThirdPartyEmotes: (roomId: string) => mockLoadThirdPartyEmotes(roomId),
  clearThirdPartyEmotes: () => mockClearThirdPartyEmotes(),
  getThirdPartyEmoteMap: () => fakeThirdPartyEmoteMap,
}));

// Cheermote 一覧の読み込みも実 API(Helix プロキシ)を呼ぶため、ストア連携だけをモックで検証する。
// getCheermoteSet は静的一覧を返し、既存の Cheermote 合成テストは静的一覧の挙動で検証する
const mockLoadCheermotes = vi.fn();
const mockClearCheermotes = vi.fn();

vi.mock("./cheermotes", async () => {
  const { STATIC_CHEERMOTE_SET } = await vi.importActual<typeof import("@/lib/twitch/cheermotes")>(
    "@/lib/twitch/cheermotes",
  );
  return {
    loadCheermotes: (roomId: string) => mockLoadCheermotes(roomId),
    clearCheermotes: () => mockClearCheermotes(),
    getCheermoteSet: () => STATIC_CHEERMOTE_SET,
  };
});

// 発言者アバターの読み込みも実 API(Helix プロキシ)を呼ぶため、ストア連携だけをモックで検証する
const mockRequestAvatar = vi.fn();
const mockClearAvatarLoadFailures = vi.fn();

vi.mock("./avatars", () => ({
  requestAvatar: (userId: string | null) => mockRequestAvatar(userId),
  clearAvatarLoadFailures: () => mockClearAvatarLoadFailures(),
}));

// チャットバッジ対応表の読み込みも実 API(Helix プロキシ)を呼ぶため、ストア連携だけをモックで検証する
const mockLoadBadges = vi.fn();
const mockClearBadges = vi.fn();

vi.mock("./badges", () => ({
  loadBadges: (roomId: string) => mockLoadBadges(roomId),
  clearBadges: () => mockClearBadges(),
}));

import { resetBotFilterStoreForTests, useBotFilterStore } from "./bot-filter";
import { hidePickupTerm, resetHiddenPickupStoreForTests, useHiddenPickupStore } from "./hidden-pickups";
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
    bits: null,
    timestampMs: 1690000000000,
    ...overrides,
  };
}

beforeEach(() => {
  // モジュールスコープのストアはテスト間で共有されるため、各テストの前に初期状態へ戻す
  resetChatConnectionStoreForTests();
  resetBotFilterStoreForTests();
  resetHiddenPickupStoreForTests();
});

afterEach(() => {
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  mockLoadThirdPartyEmotes.mockClear();
  mockClearThirdPartyEmotes.mockClear();
  mockLoadCheermotes.mockClear();
  mockClearCheermotes.mockClear();
  mockRequestAvatar.mockClear();
  mockClearAvatarLoadFailures.mockClear();
  mockLoadBadges.mockClear();
  mockClearBadges.mockClear();
  fakeThirdPartyEmoteMap = new Map();
  window.localStorage.clear();
});

describe("useChatConnectionStore", () => {
  it("connect()を呼ぶと、TwitchIrcClientのconnect()にチャンネル名がそのまま渡される", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockConnect).toHaveBeenCalledWith("ZackRawrr");
  });

  it("connect()を呼ぶと、Pick up列で削除した語句の非表示集合がクリアされる", () => {
    // 前のチャンネルの発言IDは新しいチャンネルでは二度と参照されないため、持ち越すとメモリを浪費するだけになる
    hidePickupTerm("msg-1", "gg");

    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({});
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

describe("サードパーティ emote(BTTV / FFZ / 7TV)", () => {
  it("roomstate イベントを受信すると、room-id を使ってサードパーティ emote の読み込みを開始する", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: "552120296",
      },
    });

    expect(mockLoadThirdPartyEmotes).toHaveBeenCalledWith("552120296");
  });

  it("room-id が無い roomstate では読み込みを開始しない", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: null,
      },
    });

    expect(mockLoadThirdPartyEmotes).not.toHaveBeenCalled();
  });

  it("connect() を呼ぶと、前のチャンネルのサードパーティ emote 対応表をクリアする", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockClearThirdPartyEmotes).toHaveBeenCalled();
  });

  it("privmsg 受信時に、本文中のサードパーティ emote 名を emotes に合成してから保持・通知する", () => {
    fakeThirdPartyEmoteMap = new Map([["catJAM", "bttv:60ae958e229664e8667aea38"]]);
    useChatConnectionStore.getState().connect("ZackRawrr");
    const listener = vi.fn();
    subscribeToChatMessages(listener);
    const message = createSampleMessage({ text: "catJAM nice" });

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message });

    const expected = {
      ...message,
      emotes: [{ id: "bttv:60ae958e229664e8667aea38", start: 0, end: 5 }],
    };
    expect(useChatConnectionStore.getState().messages).toEqual([expected]);
    expect(listener).toHaveBeenCalledWith(expected);
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

describe("Cheering Emote(Cheermote)", () => {
  it("bits 付きの privmsg 受信時に、本文中の Cheermote を emotes に合成してから保持・通知する", () => {
    const received: TwitchChatMessage[] = [];
    subscribeToChatMessages((message) => received.push(message));
    useChatConnectionStore.getState().connect("somechannel");
    const message = createSampleMessage({ text: "Cheer100 nice play", bits: 100 });

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message });

    const expected = [{ id: "cheer:cheer/100", start: 0, end: 4 }];
    expect(useChatConnectionStore.getState().messages[0].emotes).toEqual(expected);
    expect(received[0].emotes).toEqual(expected);
  });
});

describe("Cheermote 一覧(Helix Cheermotes API)", () => {
  it("roomstate イベントを受信すると、room-id を使って Cheermote 一覧の読み込みを開始する", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: "552120296",
      },
    });

    expect(mockLoadCheermotes).toHaveBeenCalledWith("552120296");
  });

  it("room-id が無い roomstate では読み込みを開始しない", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: null,
      },
    });

    expect(mockLoadCheermotes).not.toHaveBeenCalled();
  });

  it("connect() を呼ぶと、前のチャンネルの Cheermote 一覧をクリアする", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockClearCheermotes).toHaveBeenCalled();
  });
});

describe("発言者アバター(Helix Get Users API)", () => {
  it("privmsg 受信時に、発言者の user-id でアバターの取得を要求する", () => {
    useChatConnectionStore.getState().connect("somechannel");
    const message = createSampleMessage({ userId: "987654" });

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message });

    expect(mockRequestAvatar).toHaveBeenCalledWith("987654");
  });

  it("bot 除外に一致する発言では、アバターの取得を要求しない", () => {
    useBotFilterStore.getState().setPatterns(["streamelements"]);
    useChatConnectionStore.getState().connect("somechannel");
    const botMessage = createSampleMessage({ username: "streamelements", userId: "100135110" });

    capturedCallbacks?.onEvent({ type: "privmsg", channel: "somechannel", message: botMessage });

    expect(mockRequestAvatar).not.toHaveBeenCalled();
  });

  it("connect() を呼ぶと、アバター取得失敗の記録をクリアして再試行できるようにする", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockClearAvatarLoadFailures).toHaveBeenCalled();
  });
});

describe("チャットバッジ(Helix Chat Badges API)", () => {
  it("roomstate イベントを受信すると、room-id を使ってバッジ対応表の読み込みを開始する", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: "552120296",
      },
    });

    expect(mockLoadBadges).toHaveBeenCalledWith("552120296");
  });

  it("room-id が無い roomstate では読み込みを開始しない", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    capturedCallbacks?.onEvent({
      type: "roomstate",
      channel: "zackrawrr",
      state: {
        emoteOnly: false,
        followersOnlyMinutes: null,
        r9k: false,
        slowSeconds: 0,
        subsOnly: false,
        roomId: null,
      },
    });

    expect(mockLoadBadges).not.toHaveBeenCalled();
  });

  it("connect() を呼ぶと、前のチャンネルのバッジ対応表をクリアする", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockClearBadges).toHaveBeenCalled();
  });
});

// 配信情報(タイトル・カテゴリ)の読み込みも実 API(Helix プロキシ)を呼ぶため、ストア連携だけをモックで検証する
const { mockLoadStreamInfo, mockClearStreamInfo } = vi.hoisted(() => ({
  mockLoadStreamInfo: vi.fn(),
  mockClearStreamInfo: vi.fn(),
}));

vi.mock("./stream-info", () => ({
  loadStreamInfo: (channelLogin: string) => mockLoadStreamInfo(channelLogin),
  clearStreamInfo: () => mockClearStreamInfo(),
}));

describe("配信情報(タイトル・カテゴリ)との連携(issue #54)", () => {
  // 同ファイルの他の describe のテストも connect() を呼ぶため、呼び出し回数は各テストの直前にリセットする
  beforeEach(() => {
    mockLoadStreamInfo.mockClear();
    mockClearStreamInfo.mockClear();
  });

  it("connect()を呼ぶと、前チャンネルの配信情報をクリアしてから正規化したチャンネル名で読み込む", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");

    expect(mockClearStreamInfo).toHaveBeenCalledTimes(1);
    expect(mockLoadStreamInfo).toHaveBeenCalledWith("zackrawrr");
  });

  it("disconnect()を呼ぶと、配信情報をクリアする(切断中に古い文脈を残さないため)", () => {
    useChatConnectionStore.getState().connect("ZackRawrr");
    mockClearStreamInfo.mockClear();

    useChatConnectionStore.getState().disconnect();

    expect(mockClearStreamInfo).toHaveBeenCalledTimes(1);
  });
});
