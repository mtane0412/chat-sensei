/**
 * src/app/page.tsx(ホーム = 未接続のウェルカム画面)のテスト。
 *
 * ウェルカム画面(アプリ名 + チャンネル検索 + 言語ペア・AIモデル設定 + 配信一覧)が
 * 表示されること、チャンネル視聴はチャンネルページ(/[channel])へ分離されたため
 * 3カラム・配信embedを表示しないこと、接続中(視聴中)にホームへ戻ったら切断されることを検証する。
 * IRC 接続そのものは chat-connection ストアに閉じているため、ストアの state を直接書き換えて注入する。
 * 設定ダイアログの環境診断(`runBrowserDiagnosis`)はブラウザ API に触れるためモックする。
 * Next.js のルーティング(useRouter)はテスト環境に App Router が無いためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetBotFilterStoreForTests } from "@/store/bot-filter";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/settings";

// Next.js のルーティングをモックする。チャンネル検索フォームが接続先チャンネルの
// ページ(/[channel])へ遷移するために useRouter を使う
const mockRouterPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

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

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: () => new Promise(() => {}),
}));

// チャンネル名のオートコンプリート(issue #59)の候補取得はネットワークに触れるためモックする。
// null = Helix 利用不可(候補なし)として、ここでは手入力だけの動作を検証する
vi.mock("@/lib/twitch/channel-search", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twitch/channel-search")>()),
  fetchChannelSuggestions: () => Promise.resolve(null),
}));

// ウェルカム画面の配信一覧(issue #90)の取得もネットワークに触れるためモックする。
// 既定は null = Helix 利用不可(一覧セクションを表示しない)とし、
// 一覧を検証するテストだけ mockResolvedValue で配信データを注入する
const mockFetchLanguagePairStreams = vi.fn();

vi.mock("@/lib/twitch/stream-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twitch/stream-list")>()),
  fetchLanguagePairStreams: (...args: unknown[]) => mockFetchLanguagePairStreams(...args),
}));

import Home from "./page";

beforeEach(() => {
  mockRouterPush.mockClear();
  mockWarmUpTranslationPipeline.mockClear();
  mockWarmUpPickupPipeline.mockClear();
  mockFetchLanguagePairStreams.mockReset();
  mockFetchLanguagePairStreams.mockResolvedValue(null);
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetBotFilterStoreForTests();
  resetSettingsStoreForTests();
  window.localStorage.clear();
});

describe("Home(未接続のウェルカム画面)", () => {
  it("アプリ名の見出しと、チャンネル入力 + Connect ボタンを表示し、3カラムと配信embedは表示しない", () => {
    render(<Home />);

    expect(screen.getByRole("heading", { level: 1, name: "chat-sensei" })).toBeInTheDocument();
    expect(screen.getByLabelText("Channel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Raw Chat" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Translation" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Pick up" })).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Twitch player/)).not.toBeInTheDocument();
  });

  it("言語ペアのセレクト(学ぶ言語 / 解説言語)を表示する(未接続時はヘッダーが無いため、この画面に置く)", () => {
    render(<Home />);

    expect(screen.getByRole("combobox", { name: "Learning language" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toBeInTheDocument();
  });

  it("AIモデル設定(設定ダイアログ)を開くラベル付きボタンを表示する", async () => {
    const user = userEvent.setup();
    render(<Home />);

    // ダイアログを開くと LLM プロバイダ(AIモデル)の設定セクションが表示される
    await user.click(screen.getByRole("button", { name: "AI model settings" }));
    expect(screen.getByRole("region", { name: "LLM provider settings" })).toBeInTheDocument();
  });

  it("接続状態(Status)を表示する", () => {
    render(<Home />);

    expect(screen.getByText("Status:")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
  });

  it("マウント時に LocalStorage から言語設定を復元する(言語ペアのセレクト・配信一覧が参照するため)", () => {
    window.localStorage.setItem("chat-sensei:settings", JSON.stringify({ learningLang: "fr", explainLang: "ja" }));

    render(<Home />);

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "fr", explainLang: "ja" });
  });

  it("チャンネル接続UIの下に、言語ペアの両タグを含む配信一覧(issue #90)を表示する", async () => {
    // Learning en · explained in ja(デフォルト)の両タグを含む配信が1件見つかった状態を注入する
    mockFetchLanguagePairStreams.mockResolvedValue([
      {
        login: "eigo_sensei",
        displayName: "英語の先生",
        title: "English & Japanese chatting stream",
        category: "Just Chatting",
        viewerCount: 321,
        thumbnailUrl: "",
        tags: ["English", "日本語"],
      },
    ]);
    render(<Home />);

    expect(
      await screen.findByRole("heading", { name: "Live streams tagged English · 日本語" }),
    ).toBeInTheDocument();
    expect(screen.getByText("English & Japanese chatting stream")).toBeInTheDocument();
  });

  it("配信一覧の取得に失敗した場合(Helix 利用不可)は、一覧セクションを表示しない", async () => {
    render(<Home />);

    // 既定のモック(null)が解決されるのを待ってから、セクションが無いことを確認する
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: /Live streams tagged/ })).not.toBeInTheDocument();
  });

  it("切断(closed)後もウェルカム画面を表示する", () => {
    useChatConnectionStore.setState({ connectionState: "closed" });

    render(<Home />);

    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Raw Chat" })).not.toBeInTheDocument();
  });
});

describe("Home(視聴中にホームへ戻ったときの切断)", () => {
  it("接続中(open)にマウントされたら disconnect を呼ぶ(ロゴクリックでホームへ戻る動作。URLが接続状態の起点)", () => {
    const disconnectMock = vi.fn();
    useChatConnectionStore.setState({ connectionState: "open", channel: "example", disconnect: disconnectMock });

    render(<Home />);

    expect(disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("未接続(idle)でマウントされても disconnect は呼ばない", () => {
    const disconnectMock = vi.fn();
    useChatConnectionStore.setState({ connectionState: "idle", channel: null, disconnect: disconnectMock });

    render(<Home />);

    expect(disconnectMock).not.toHaveBeenCalled();
  });
});
