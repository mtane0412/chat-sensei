/**
 * src/components/stream-info-panel.tsx(接続中の配信者情報パネル)のテスト。
 *
 * 接続中の画面上半分で配信embedの横に置くパネルが、次を表示することを検証する。
 *
 * - 配信者の表示名(配信情報が無い間は接続中のチャンネル名で代用)
 * - 配信者のアバター(avatars ストアに取得済みの場合のみ)と、アバター取得の要求
 * - 配信タイトル・カテゴリ(ボックスアート画像はゲームIDから取得できた場合のみ)
 * - 同時視聴者数(取得できた場合のみ)
 * - 接続状態と Disconnect ボタン
 *
 * 配信情報・アバターは各ストアの state を直接書き換えて注入し、
 * ボックスアート取得(`fetchGameBoxArtUrl`)とアバター取得要求(`requestAvatar`)はモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StreamInfo } from "@/lib/twitch/stream-info";
import { resetAvatarsForTests, useAvatarStore } from "@/store/avatars";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetStreamInfoForTests, useStreamInfoStore } from "@/store/stream-info";

const mockFetchGameBoxArtUrl = vi.fn<(gameId: string) => Promise<string | null>>();

vi.mock("@/lib/twitch/game-box-art", () => ({
  fetchGameBoxArtUrl: (gameId: string) => mockFetchGameBoxArtUrl(gameId),
}));

const mockRequestAvatar = vi.fn();

vi.mock("@/store/avatars", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/avatars")>()),
  requestAvatar: (...args: unknown[]) => mockRequestAvatar(...args),
}));

import { StreamInfoPanel } from "./stream-info-panel";

const サンプル配信情報: StreamInfo = {
  title: "Mythic raid progression! !drops",
  category: "World of Warcraft",
  broadcasterId: "552120296",
  broadcasterLogin: "zackrawrr",
  broadcasterName: "ZackRawrr",
  gameId: "18122",
  viewerCount: 4321,
};

beforeEach(() => {
  mockFetchGameBoxArtUrl.mockResolvedValue(null);
  useChatConnectionStore.setState({ connectionState: "open", channel: "zackrawrr" });
});

afterEach(() => {
  mockFetchGameBoxArtUrl.mockReset();
  mockRequestAvatar.mockClear();
  resetChatConnectionStoreForTests();
  resetStreamInfoForTests();
  resetAvatarsForTests();
});

describe("StreamInfoPanel(配信情報あり)", () => {
  beforeEach(() => {
    useStreamInfoStore.setState({ streamInfo: サンプル配信情報 });
  });

  it("配信者の表示名・配信タイトル・カテゴリ名を表示する", () => {
    render(<StreamInfoPanel />);

    expect(screen.getByText("ZackRawrr")).toBeInTheDocument();
    expect(screen.getByText("Mythic raid progression! !drops")).toBeInTheDocument();
    expect(screen.getByText("World of Warcraft")).toBeInTheDocument();
  });

  it("同時視聴者数を桁区切りで表示する", () => {
    render(<StreamInfoPanel />);

    expect(screen.getByText("4,321 viewers")).toBeInTheDocument();
  });

  it("配信者のアバター取得を要求し、取得済みならアバター画像を表示する", () => {
    useAvatarStore.setState({ avatars: { "552120296": "https://example.com/avatar.png" } });

    const { container } = render(<StreamInfoPanel />);

    expect(mockRequestAvatar).toHaveBeenCalledWith("552120296");
    expect(container.querySelector('img[src="https://example.com/avatar.png"]')).not.toBeNull();
  });

  it("アバター未取得の間は、アバター画像なしで表示する", () => {
    const { container } = render(<StreamInfoPanel />);

    expect(container.querySelector('img[src="https://example.com/avatar.png"]')).toBeNull();
  });

  it("ゲームIDからボックスアートを取得できた場合、カテゴリの画像として表示する", async () => {
    mockFetchGameBoxArtUrl.mockResolvedValue("https://static-cdn.jtvnw.net/ttv-boxart/18122-285x380.jpg");

    render(<StreamInfoPanel />);

    expect(mockFetchGameBoxArtUrl).toHaveBeenCalledWith("18122");
    expect(await screen.findByRole("img", { name: "World of Warcraft" })).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/ttv-boxart/18122-285x380.jpg",
    );
  });

  it("ボックスアートを取得できない場合、カテゴリ名のテキストのみ表示する", async () => {
    render(<StreamInfoPanel />);

    // fetchGameBoxArtUrl の解決を待ってから、画像が無いことを確認する
    await act(async () => {});
    expect(screen.queryByRole("img", { name: "World of Warcraft" })).toBeNull();
    expect(screen.getByText("World of Warcraft")).toBeInTheDocument();
  });
});

describe("StreamInfoPanel(配信情報なし = オフライン・Helix 利用不可)", () => {
  it("接続中のチャンネル名を表示し、タイトル・視聴者数は表示しない", () => {
    render(<StreamInfoPanel />);

    expect(screen.getByText("zackrawrr")).toBeInTheDocument();
    expect(screen.queryByText(/viewers/)).toBeNull();
  });

  it("ゲームIDが無いためボックスアートの取得を要求しない", () => {
    render(<StreamInfoPanel />);

    expect(mockFetchGameBoxArtUrl).not.toHaveBeenCalled();
  });
});

describe("StreamInfoPanel(接続状態と切断)", () => {
  it("接続状態のラベルを表示する", () => {
    useChatConnectionStore.setState({ connectionState: "reconnecting" });

    render(<StreamInfoPanel />);

    expect(screen.getByText(/Reconnecting/)).toBeInTheDocument();
  });

  it("Disconnect ボタンを押すと切断処理を呼ぶ", async () => {
    const user = userEvent.setup();
    const disconnectMock = vi.fn();
    useChatConnectionStore.setState({ disconnect: disconnectMock });

    render(<StreamInfoPanel />);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });
});
