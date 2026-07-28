/**
 * src/app/page.tsx(ライブチャット画面)のテスト。
 *
 * Phase 1 の主要導線である「チャンネル名を入力して接続する → 受信した発言が
 * 表示名・色・emote付きで表示される → 切断する」という流れを検証する。
 * 実際のWebSocket通信は行わず、`createTwitchIrcClient` をモックして
 * コールバックを直接呼び出すことで受信イベントをシミュレートする。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "./page";
import type { TwitchIrcClientCallbacks } from "@/lib/twitch/irc-client";

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
}));

afterEach(() => {
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  capturedCallbacks = null;
});

describe("Home(ライブチャット画面)", () => {
  it("チャンネル名を入力して接続すると、受信した発言が表示名・本文付きで表示される", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const input = screen.getByLabelText("チャンネル名");
    await user.type(input, "ZackRawrr");
    await user.click(screen.getByRole("button", { name: "接続する" }));

    expect(mockConnect).toHaveBeenCalledWith("ZackRawrr");

    // クライアントからの状態通知・メッセージ受信をシミュレートする
    capturedCallbacks?.onStateChange?.("open");
    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "zackrawrr",
      message: {
        id: "msg-1",
        channel: "zackrawrr",
        userId: "987654",
        username: "codechamp92",
        displayName: "CodeChamp92",
        color: "#1E90FF",
        text: "nice play chat",
        isAction: false,
        emotes: [],
        badges: [],
        timestampMs: 1690000000000,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("CodeChamp92")).toBeInTheDocument();
    });
    expect(screen.getByText("nice play chat")).toBeInTheDocument();
    expect(screen.getByText("接続済み")).toBeInTheDocument();
  });

  it("接続済みの状態で切断ボタンを押すと disconnect() が呼ばれる", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByLabelText("チャンネル名"), "somechannel");
    await user.click(screen.getByRole("button", { name: "接続する" }));
    capturedCallbacks?.onStateChange?.("open");

    await user.click(await screen.findByRole("button", { name: "切断する" }));

    expect(mockDisconnect).toHaveBeenCalled();
  });

  it("emoteを含む発言はテキストと画像に分割して表示される", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByLabelText("チャンネル名"), "somechannel");
    await user.click(screen.getByRole("button", { name: "接続する" }));
    capturedCallbacks?.onStateChange?.("open");

    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: {
        id: "msg-2",
        channel: "somechannel",
        userId: "111",
        username: "lurker42",
        displayName: "lurker42",
        color: null,
        text: "nice Kappa play",
        isAction: false,
        emotes: [{ id: "25", start: 5, end: 9 }],
        badges: [],
        timestampMs: 1690000000000,
      },
    });

    const emoteImage = await screen.findByRole("img", { name: "Kappa" });
    expect(emoteImage).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0",
    );
  });
});
