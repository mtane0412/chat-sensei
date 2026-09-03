/**
 * src/components/site-header.tsx のテスト。
 *
 * 共通ヘッダーが接続中(connecting / open / reconnecting)にだけ表示されることと、
 * 表示中は左にアプリ名のリンク、中央にチャンネル検索(別チャンネルへの移動用)、
 * 右に言語ペアのセレクトと設定ダイアログのトリガーを持つことを検証する。
 * 未接続(idle / closed)のトップページはヘッダーなしのウェルカム画面
 * (`src/app/page.tsx`)になるため、ヘッダーは何も描画しない。
 * 設定ダイアログの環境診断(`runBrowserDiagnosis`)はブラウザ API に触れるためモックする。
 * チャンネル検索のオートコンプリート候補取得もネットワークに触れるためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetSettingsStoreForTests } from "@/store/settings";

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: () => new Promise(() => {}),
}));

// チャンネル名のオートコンプリート(issue #59)の候補取得はネットワークに触れるためモックする
vi.mock("@/lib/twitch/channel-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twitch/channel-search")>()),
  fetchChannelSuggestions: () => Promise.resolve(null),
}));

import { SiteHeader } from "./site-header";

beforeEach(() => {
  // ヘッダーは接続中にだけ表示されるため、既定で接続済み(open)にする
  useChatConnectionStore.setState({ connectionState: "open", channel: "example" });
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetSettingsStoreForTests();
  window.localStorage.clear();
});

describe("SiteHeader", () => {
  it("未接続(idle)の間は何も描画しない(トップページはヘッダーなしのウェルカム画面にする)", () => {
    useChatConnectionStore.setState({ connectionState: "idle", channel: null });
    render(<SiteHeader />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("切断後(closed)も何も描画しない", () => {
    useChatConnectionStore.setState({ connectionState: "closed", channel: null });
    render(<SiteHeader />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
  });

  it("接続中はアプリ名(chat-sensei)をホームへのリンクとして表示する", () => {
    render(<SiteHeader />);

    const homeLink = screen.getByRole("link", { name: "chat-sensei" });
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("接続中はヘッダー中央にチャンネル検索(別チャンネルへの移動用)を表示する", () => {
    render(<SiteHeader />);

    expect(screen.getByLabelText("Search channel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
  });

  it("接続中はヘッダー右側に言語ペアのセレクト(学ぶ言語 / 解説言語)を表示する", () => {
    render(<SiteHeader />);

    expect(screen.getByRole("combobox", { name: "Learning language" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toBeInTheDocument();
  });

  it("接続中はヘッダー右側に設定ダイアログを開くボタンを表示する", () => {
    render(<SiteHeader />);

    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("ヘッダーは Surface 色(bg-card)で描画し、配信embedと地続きに見せる(issue #87)", () => {
    render(<SiteHeader />);

    const header = screen.getByRole("banner");
    expect(header.className).toContain("bg-card");
  });
});
