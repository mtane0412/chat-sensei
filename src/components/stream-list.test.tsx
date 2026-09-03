/**
 * src/components/stream-list.tsx(言語ペアタグ付き配信一覧)のテスト。
 *
 * ウェルカム画面に表示する「選択中の言語ペアの両タグを含むライブ配信」の一覧が、
 * 設定ストアの復元(hydrate)後に取得を始めること、取得結果をカードとして表示すること、
 * カードのクリックでそのチャンネルのページ(/[channel])へ遷移し翻訳・Pick up のセッションを
 * ウォームアップすること(接続はチャンネルページがURLを起点に行う)、0件・取得失敗時の表示を検証する。
 * 実際の API 呼び出しは行わず、取得関数(fetchLanguagePairStreams)をモックに差し替える。
 * Next.js のルーティング(useRouter)はテスト環境に App Router が無いためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { TaggedStream } from "@/lib/twitch/stream-list";
import { resetChatConnectionStoreForTests } from "@/store/chat-connection";
import { resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";

// チャンネルページ(/[channel])への遷移を検証するため useRouter をモックする
const mockRouterPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockRouterPush, replace: vi.fn(), prefetch: vi.fn() }),
}));

const mockFetchLanguagePairStreams = vi.fn();
vi.mock("@/lib/twitch/stream-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/twitch/stream-list")>()),
  fetchLanguagePairStreams: (...args: unknown[]) => mockFetchLanguagePairStreams(...args),
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

import { LanguagePairStreamList } from "./stream-list";

/** 一覧表示の検証に使う配信データ(英語・日本語の両タグ付き) */
function createTaggedStream(overrides: Partial<TaggedStream> = {}): TaggedStream {
  return {
    login: "eigo_sensei",
    displayName: "英語の先生",
    title: "English & Japanese chatting stream",
    category: "Just Chatting",
    viewerCount: 1234,
    thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_eigo_sensei-440x248.jpg",
    tags: ["English", "日本語"],
    ...overrides,
  };
}

/** 設定ストアを復元済み(デフォルト: Learning en · explained in ja)にする */
function hydrateSettingsForTest(): void {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, hydrated: true });
}

beforeEach(() => {
  mockRouterPush.mockClear();
  mockFetchLanguagePairStreams.mockReset();
  mockWarmUpTranslationPipeline.mockClear();
  mockWarmUpPickupPipeline.mockClear();
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetSettingsStoreForTests();
});

describe("LanguagePairStreamList", () => {
  it("設定ストアが未復元(hydrated: false)の間は何も表示せず、取得も始めない", () => {
    const { container } = render(<LanguagePairStreamList />);

    expect(container).toBeEmptyDOMElement();
    expect(mockFetchLanguagePairStreams).not.toHaveBeenCalled();
  });

  it("復元後、選択中の言語ペア(学習言語・解説言語)で配信一覧を取得する", async () => {
    mockFetchLanguagePairStreams.mockResolvedValue([]);
    hydrateSettingsForTest();
    render(<LanguagePairStreamList />);

    await waitFor(() => {
      expect(mockFetchLanguagePairStreams).toHaveBeenCalledWith("en", "ja", expect.anything());
    });
  });

  it("取得した配信を、言語ペアの見出しとともにカードで表示する(タイトル・表示名・カテゴリ・視聴者数)", async () => {
    mockFetchLanguagePairStreams.mockResolvedValue([createTaggedStream()]);
    hydrateSettingsForTest();
    render(<LanguagePairStreamList />);

    // 見出しは言語ペアのセレクト(Learning English · explained in 日本語)と同じ表示名を使う
    expect(await screen.findByRole("heading", { name: "Live streams tagged English · 日本語" })).toBeInTheDocument();
    expect(screen.getByText("English & Japanese chatting stream")).toBeInTheDocument();
    expect(screen.getByText("英語の先生")).toBeInTheDocument();
    expect(screen.getByText("Just Chatting")).toBeInTheDocument();
    // 視聴者数は桁区切りで表示する(単位はスクリーンリーダー向けの sr-only で補う)
    expect(screen.getByText("1,234")).toBeInTheDocument();
  });

  it("カードをクリックすると、そのチャンネルのページ(/[channel])へ遷移し、翻訳・Pick up のセッションをウォームアップする", async () => {
    const user = userEvent.setup();
    mockFetchLanguagePairStreams.mockResolvedValue([createTaggedStream()]);
    hydrateSettingsForTest();
    render(<LanguagePairStreamList />);

    await user.click(await screen.findByRole("button", { name: /英語の先生/ }));

    // 接続はチャンネルページがURLを起点に行うため、ここでは遷移のみを行う
    expect(mockRouterPush).toHaveBeenCalledWith("/eigo_sensei");
    expect(mockWarmUpTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockWarmUpPickupPipeline).toHaveBeenCalledTimes(1);
  });

  it("該当する配信が0件の場合は、空状態の文言を表示する", async () => {
    mockFetchLanguagePairStreams.mockResolvedValue([]);
    hydrateSettingsForTest();
    render(<LanguagePairStreamList />);

    expect(
      await screen.findByText("No live streams with both language tags right now."),
    ).toBeInTheDocument();
  });

  it("取得に失敗した場合(null)は、一覧セクションごと表示しない(静かなフォールバック)", async () => {
    mockFetchLanguagePairStreams.mockResolvedValue(null);
    hydrateSettingsForTest();
    const { container } = render(<LanguagePairStreamList />);

    await waitFor(() => {
      expect(mockFetchLanguagePairStreams).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("言語ペアの変更に追従して一覧を取得し直す", async () => {
    mockFetchLanguagePairStreams.mockResolvedValue([]);
    hydrateSettingsForTest();
    render(<LanguagePairStreamList />);
    await waitFor(() => {
      expect(mockFetchLanguagePairStreams).toHaveBeenCalledWith("en", "ja", expect.anything());
    });

    // 言語ペアを Learning ja · explained in en に変更する
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS, learningLang: "ja", explainLang: "en" },
    });

    await waitFor(() => {
      expect(mockFetchLanguagePairStreams).toHaveBeenCalledWith("ja", "en", expect.anything());
    });
  });
});
