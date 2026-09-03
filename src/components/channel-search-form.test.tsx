/**
 * src/components/channel-search-form.tsx のテスト。
 *
 * チャンネル検索 + 接続の共通フォーム(ウェルカム画面の hero / ヘッダー中央の navbar の2バリアント)が、
 * 入力値で chat-connection ストアの connect を呼ぶこと、接続クリックの延長で翻訳・Pick up の
 * セッションをウォームアップすること(モデルDLにユーザー操作が必要なため)、空入力では何もしないことを検証する。
 * 実際の IRC 接続(WebSocket)は行わず、connect をモックに差し替える。
 * オートコンプリートの候補取得はネットワークに触れるためモックする(null = Helix 利用不可)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";

const mockWarmUpTranslationPipeline = vi.fn();
vi.mock("@/store/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/translations")>()),
  warmUpTranslationPipeline: () => mockWarmUpTranslationPipeline(),
}));

const mockWarmUpPickupPipeline = vi.fn();
vi.mock("@/store/pickups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/pickups")>()),
  warmUpPickupPipeline: () => mockWarmUpPickupPipeline(),
}));

// チャンネル名のオートコンプリート(issue #59)の候補取得はネットワークに触れるためモックする。
// null = Helix 利用不可(候補なし)として、ここでは手入力だけの動作を検証する
vi.mock("@/lib/twitch/channel-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twitch/channel-search")>()),
  fetchChannelSuggestions: () => Promise.resolve(null),
}));

import { ChannelSearchForm } from "./channel-search-form";

beforeEach(() => {
  mockWarmUpTranslationPipeline.mockClear();
  mockWarmUpPickupPipeline.mockClear();
});

afterEach(() => {
  resetChatConnectionStoreForTests();
});

describe("ChannelSearchForm(hero: ウェルカム画面)", () => {
  it("Channel ラベル付きの入力欄と Connect ボタンを表示する", () => {
    render(<ChannelSearchForm variant="hero" />);

    expect(screen.getByLabelText("Channel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("入力が空の間は Connect ボタンを無効化する", () => {
    render(<ChannelSearchForm variant="hero" />);

    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("チャンネル名を入力して Connect を押すと、前後の空白を除いた値で connect を呼ぶ", async () => {
    const user = userEvent.setup();
    const connectMock = vi.fn();
    useChatConnectionStore.setState({ connect: connectMock });
    render(<ChannelSearchForm variant="hero" />);

    await user.type(screen.getByLabelText("Channel"), "  example_streamer  ");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(connectMock).toHaveBeenCalledWith("example_streamer");
  });

  it("Connect クリック(ユーザー操作)の延長で翻訳・Pick upのセッションをウォームアップする", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ connect: vi.fn() });
    render(<ChannelSearchForm variant="hero" />);

    await user.type(screen.getByLabelText("Channel"), "example_streamer");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mockWarmUpTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockWarmUpPickupPipeline).toHaveBeenCalledTimes(1);
  });

  it("接続状態(Status)を表示する", () => {
    render(<ChannelSearchForm variant="hero" />);

    expect(screen.getByRole("status")).toHaveTextContent("Status: Idle");
  });
});

describe("ChannelSearchForm(navbar: ヘッダー中央)", () => {
  it("チャンネル検索の入力欄と接続ボタン(アイコン)を表示し、Status は表示しない", () => {
    render(<ChannelSearchForm variant="navbar" />);

    expect(screen.getByLabelText("Search channel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("チャンネル名を入力して Enter(フォーム送信)で connect を呼ぶ", async () => {
    const user = userEvent.setup();
    const connectMock = vi.fn();
    useChatConnectionStore.setState({ connect: connectMock });
    render(<ChannelSearchForm variant="navbar" />);

    await user.type(screen.getByLabelText("Search channel"), "example_streamer{Enter}");

    expect(connectMock).toHaveBeenCalledWith("example_streamer");
    expect(mockWarmUpTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockWarmUpPickupPipeline).toHaveBeenCalledTimes(1);
  });

  it("フォーム送信後は入力欄を空に戻す(接続後に検索語を残さない)", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ connect: vi.fn() });
    render(<ChannelSearchForm variant="navbar" />);

    const input = screen.getByLabelText("Search channel");
    await user.type(input, "example_streamer{Enter}");

    expect(input).toHaveValue("");
  });

  it("入力が空のままフォーム送信しても connect を呼ばない", async () => {
    const user = userEvent.setup();
    const connectMock = vi.fn();
    useChatConnectionStore.setState({ connect: connectMock });
    render(<ChannelSearchForm variant="navbar" />);

    await user.click(screen.getByLabelText("Search channel"));
    await user.keyboard("{Enter}");

    expect(connectMock).not.toHaveBeenCalled();
  });
});
