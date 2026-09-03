/**
 * src/app/[channel]/page.tsx(チャンネル視聴ページ = 配信embed + 3カラムのチャット閲覧画面)のテスト。
 *
 * URL のチャンネル名(/[channel])で IRC 接続が開始されること、切断でホーム(/)へ戻ること、
 * 生IRC / 翻訳 / Pick up の3列が描画されること、受信済み発言が生IRC列に
 * 表示されること、翻訳列・Pick up列に発言ごとの状態が表示されること、
 * 翻訳列・Pick up列のぼかしをトグルで切り替えられること、生IRC列の追従トグルで新着時に
 * スクロール領域が最下部へ送られることを検証する。
 * IRC 接続そのものは chat-connection ストアに、翻訳の生成は translations ストアに、
 * 注目の表現の抽出は pickups ストアに、Prompt API の利用可否は prompt-api ストアに閉じているため、
 * ここでは各ストアの state を直接書き換えて注入する。
 * 各パイプラインの開始(`startTranslationPipeline` / `startPickupPipeline`)はブラウザAPIに触れるためモックする。
 * 設定ダイアログの環境診断(`runBrowserDiagnosis`)も同様にモックする。
 * Next.js のルーティング(useParams / useRouter)はテスト環境に App Router が無いためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { resetAvatarsForTests, useAvatarStore } from "@/store/avatars";
import { resetBadgesForTests, useBadgeStore } from "@/store/badges";
import { resetBotFilterStoreForTests, useBotFilterStore } from "@/store/bot-filter";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetHiddenPickupStoreForTests } from "@/store/hidden-pickups";
import { resetPickupAnnouncementStoreForTests } from "@/store/pickup-announcements";
import { resetManualPickupStoreForTests, useManualPickupStore } from "@/store/manual-pickups";
import { resetPickupStoreForTests, usePickupStore } from "@/store/pickups";
import { resetPromptApiStoreForTests, usePromptApiStore } from "@/store/prompt-api";
import { resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";
import { resetTranslationStoreForTests, useTranslationStore } from "@/store/translations";

// Next.js のルーティングをモックする。URL のチャンネル名(useParams)と、
// 切断時のホームへの遷移(useRouter().replace)を差し替えて検証する
const mockRouterReplace = vi.fn();
const mockRouterPush = vi.fn();
// 各テストは既定で /example を表示している(接続済みの既定状態と対応)
let mockChannelParam = "example";

vi.mock("next/navigation", () => ({
  useParams: () => ({ channel: mockChannelParam }),
  useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace, prefetch: vi.fn() }),
}));

const mockStopPipeline = vi.fn();
const mockStartTranslationPipeline = vi.fn(() => mockStopPipeline);
const mockWarmUpTranslationPipeline = vi.fn();

vi.mock("@/store/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/translations")>()),
  startTranslationPipeline: () => mockStartTranslationPipeline(),
  warmUpTranslationPipeline: () => mockWarmUpTranslationPipeline(),
}));

const mockStopPickupPipeline = vi.fn();
const mockStartPickupPipeline = vi.fn(() => mockStopPickupPipeline);
const mockWarmUpPickupPipeline = vi.fn();

vi.mock("@/store/pickups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/pickups")>()),
  startPickupPipeline: () => mockStartPickupPipeline(),
  warmUpPickupPipeline: () => mockWarmUpPickupPipeline(),
}));

// 手動Pick up(issue #72)の追加はセッションプール生成(ブラウザAPI)まで到達するためモックし、
// 呼び出し引数(発言ID・選択語句・発言本文)だけを検証する。表示はストアの state を直接注入して検証する
const mockAddManualPickup = vi.fn();

vi.mock("@/store/manual-pickups", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/manual-pickups")>()),
  addManualPickup: (...args: unknown[]) => mockAddManualPickup(...args),
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


import ChannelPage from "./page";

const サンプル発言: TwitchChatMessage = {
  id: "msg-1",
  channel: "example",
  userId: "1234",
  username: "viewer_taro",
  displayName: "viewer_taro",
  color: "#ff0000",
  text: "gg no re chat",
  isAction: false,
  emotes: [],
  badges: [],
  bits: null,
  timestampMs: 1_700_000_000_000,
};

/** 2件目のサンプル発言(1件目とは別の ID・本文) */
const サンプル発言2: TwitchChatMessage = {
  ...サンプル発言,
  id: "msg-2",
  displayName: "viewer_hanako",
  text: "this is so real",
};

// Testing Library の自動 cleanup(unmount)はこの afterEach より後に走るため、
// 前のテストの unmount による stop 呼び出しを持ち越さないよう beforeEach でクリアする
beforeEach(() => {
  mockStartTranslationPipeline.mockClear();
  mockStopPipeline.mockClear();
  mockWarmUpTranslationPipeline.mockClear();
  mockStartPickupPipeline.mockClear();
  mockStopPickupPipeline.mockClear();
  mockWarmUpPickupPipeline.mockClear();
  mockAddManualPickup.mockClear();
  mockRouterReplace.mockClear();
  mockRouterPush.mockClear();
  mockChannelParam = "example";
  // 多くのテストは接続中(embed + 3カラム)の画面を検証するため、既定で接続済み(open)にする。
  // URL(/example)とストアのチャンネルが一致しているため、マウント時の再接続は起きない。
  // 実際の IRC 接続(WebSocket)は行わないよう connect はモックし、実装と同じく
  // チャンネル名とステートを同期的にストアへ反映する
  useChatConnectionStore.setState({
    connectionState: "open",
    channel: "example",
    connect: (channel: string) =>
      useChatConnectionStore.setState({ connectionState: "connecting", channel, messages: [] }),
  });
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetTranslationStoreForTests();
  resetPickupStoreForTests();
  resetHiddenPickupStoreForTests();
  resetPickupAnnouncementStoreForTests();
  resetManualPickupStoreForTests();
  resetPromptApiStoreForTests();
  resetBotFilterStoreForTests();
  resetSettingsStoreForTests();
  resetAvatarsForTests();
  resetBadgesForTests();
  window.localStorage.clear();
});

describe("ChannelPage(3カラム構成)", () => {
  it("生IRC・翻訳・Pick upの3列を見出し付きで表示する", () => {
    render(<ChannelPage />);

    expect(screen.getByRole("region", { name: "Raw Chat" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Translation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pick up" })).toBeInTheDocument();
  });

  it("受信済みの発言を生IRC列に表示名付きで表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(within(rawColumn).getByText("gg no re chat")).toBeInTheDocument();
  });

  it("アバター取得済みの発言者には、生IRC列の発言行にアバター画像を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    // サンプル発言の発言者(userId: "1234")のアバターだけが取得済みの状態
    useAvatarStore.setState({ avatars: { "1234": "https://cdn.example/taro.png" } });

    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    const avatar = rawColumn.querySelector('img[src="https://cdn.example/taro.png"]');
    expect(avatar).not.toBeNull();
  });

  it("アバター未取得の発言者は、アバターなしの現行表示のまま表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(rawColumn.querySelector('img[src="https://cdn.example/taro.png"]')).toBeNull();
  });

  it("対応表にあるバッジを、生IRC列の発言行の表示名の前に画像で表示する", () => {
    // モデレーターかつサブスク3ヶ月の発言者。サブスクバッジはチャンネル固有画像
    useChatConnectionStore.setState({
      messages: [
        {
          ...サンプル発言,
          badges: [
            { name: "moderator", version: "1" },
            { name: "subscriber", version: "3" },
          ],
        },
      ],
    });
    useBadgeStore.setState({
      badgeImages: {
        "moderator/1": "https://cdn.example/moderator/1/2x.png",
        "subscriber/3": "https://cdn.example/channel/subscriber/3/2x.png",
      },
    });

    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    expect(rawColumn.querySelector('img[src="https://cdn.example/moderator/1/2x.png"]')).not.toBeNull();
    expect(rawColumn.querySelector('img[src="https://cdn.example/channel/subscriber/3/2x.png"]')).not.toBeNull();
  });

  it("対応表に無いバッジ・対応表が未読み込み(Helix 利用不可)の場合は、バッジを表示せず現行どおり動作する", () => {
    useChatConnectionStore.setState({
      messages: [{ ...サンプル発言, badges: [{ name: "moderator", version: "1" }] }],
    });
    // 対応表は空(未読み込み・Helix 利用不可)

    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(rawColumn.querySelector('img[alt="moderator"]')).toBeNull();
  });

  it("翻訳列とPick up列は初期状態では見えており(ぼかし無し)、トグルでぼかせる", async () => {
    const user = userEvent.setup();
    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(translationColumn).toHaveAttribute("data-blurred", "false");
    expect(pickupColumn).toHaveAttribute("data-blurred", "false");

    // トグルは各列の見出し(ヘッダー)内に目のアイコンとして置く
    const translationToggle = within(translationColumn).getByRole("switch", { name: "Blur translation" });
    const pickupToggle = within(pickupColumn).getByRole("switch", { name: "Blur Pick up" });
    expect(translationToggle).toHaveAttribute("aria-checked", "false");
    expect(pickupToggle).toHaveAttribute("aria-checked", "false");

    await user.click(translationToggle);
    expect(translationToggle).toHaveAttribute("aria-checked", "true");
    expect(translationColumn).toHaveAttribute("data-blurred", "true");
    expect(pickupColumn).toHaveAttribute("data-blurred", "false");

    await user.click(pickupToggle);
    expect(pickupToggle).toHaveAttribute("aria-checked", "true");
    expect(pickupColumn).toHaveAttribute("data-blurred", "true");
  });

  it("ぼかしトグルはぼかし中は EyeOff、解除中は Eye のアイコンを表示する", async () => {
    const user = userEvent.setup();
    render(<ChannelPage />);

    const toggle = screen.getByRole("switch", { name: "Blur translation" });
    expect(toggle.querySelector(".lucide-eye")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye-off")).toBeNull();

    await user.click(toggle);
    expect(toggle.querySelector(".lucide-eye-off")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye")).toBeNull();
  });


  it("マウント時に翻訳・Pick upのパイプラインを開始し、アンマウント時に停止する", () => {
    const { unmount } = render(<ChannelPage />);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
    expect(mockStopPickupPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("ChannelPage(翻訳列)", () => {
  it("完了した翻訳を、対応する発言と同じ順序で翻訳列に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    useTranslationStore.setState({
      entries: {
        "msg-1": { status: "done", segments: [{ type: "text", text: "ナイスゲーム、再戦なし、チャット" }] },
        "msg-2": { status: "done", segments: [{ type: "text", text: "これはマジでそう" }] },
      },
    });

    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const rows = within(translationColumn).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("ナイスゲーム、再戦なし、チャット");
    expect(rows[1]).toHaveTextContent("これはマジでそう");
  });

  it("訳文の emote セグメントは、左列と同じ emote 画像として表示する(issue #28 → #44)", () => {
    const emote付き発言: TwitchChatMessage = {
      ...サンプル発言,
      text: "why sayuwuLul lol",
      emotes: [{ id: "emotesv2_1", start: 4, end: 12 }],
    };
    useChatConnectionStore.setState({ messages: [emote付き発言] });
    useTranslationStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          segments: [
            { type: "text", text: "なんで" },
            { type: "emote", id: "emotesv2_1", text: "sayuwuLul" },
            { type: "text", text: "そんな" },
          ],
        },
      },
    });

    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const image = within(translationColumn).getByRole("img", { name: "sayuwuLul" });
    expect(image).toHaveAttribute("src", expect.stringContaining("/emotesv2_1/"));
    expect(within(translationColumn).queryByText(/sayuwuLul/)).not.toBeInTheDocument();
    expect(within(translationColumn).getByText("なんで")).toBeInTheDocument();
  });

  it("翻訳列の各行は対応する発言の ID と紐づく(行の高さを左列と揃えるための共通キー)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "訳文" }] } } });

    render(<ChannelPage />);

    const rawRow = within(screen.getByRole("region", { name: "Raw Chat" })).getByRole("listitem");
    const translationRow = within(screen.getByRole("region", { name: "Translation" })).getByRole("listitem");
    expect(rawRow).toHaveAttribute("data-message-id", "msg-1");
    expect(translationRow).toHaveAttribute("data-message-id", "msg-1");
  });

  it("生成中の行は「翻訳中」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "pending" } } });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Translating...")).toBeInTheDocument();
  });

  it("失敗した行は理由付きで「翻訳に失敗」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      entries: { "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } },
    });

    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    expect(within(translationColumn).getByText(/Translation failed/)).toBeInTheDocument();
    expect(within(translationColumn).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();
  });

  it("キュー溢れで破棄された行は「未翻訳(流量超過)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "dropped" } } });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Not translated (too many messages)")).toBeInTheDocument();
  });

  it("Prompt API が利用できない環境では、行ごとに「翻訳不可」と表示し、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });
    useTranslationStore.setState({ entries: { "msg-1": { status: "unavailable" } } });

    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    expect(within(translationColumn).getByText("Translation unavailable")).toBeInTheDocument();
    expect(within(translationColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("ID を持たない発言の行は「未翻訳(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    useTranslationStore.setState({ entries: {} });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Not translated (no message ID)")).toBeInTheDocument();
  });

  it("翻訳のぼかしを入れると翻訳列の各行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "訳文" }] } } });

    render(<ChannelPage />);

    const translationRow = within(screen.getByRole("region", { name: "Translation" })).getByRole("listitem");
    expect(translationRow).not.toHaveClass("blur-sm");

    const toggle = screen.getByRole("switch", { name: "Blur translation" });
    await user.click(toggle);
    expect(translationRow).toHaveClass("blur-sm");
    // ぼかし中はフォーカス・読み上げの対象からも外す(視覚だけ隠して中身が漏れないように)
    expect(translationRow).toHaveAttribute("inert");

    await user.click(toggle);
    expect(translationRow).not.toHaveClass("blur-sm");
    expect(translationRow).not.toHaveAttribute("inert");
  });
});

describe("ChannelPage(Pick up列)", () => {
  it("抽出された語句と意味のペアを、対応する発言と同じ行に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    usePickupStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          terms: [
            { term: "gg", meaning: "good game の略、お疲れ" },
            { term: "no re", meaning: "再戦なし" },
          ],
        },
        "msg-2": { status: "done", terms: [{ term: "so real", meaning: "激しく同意" }] },
      },
    });

    render(<ChannelPage />);

    const rows = within(screen.getByRole("region", { name: "Pick up" })).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-message-id", "msg-1");
    expect(rows[0]).toHaveTextContent("gg");
    expect(rows[0]).toHaveTextContent("good game の略、お疲れ");
    expect(rows[0]).toHaveTextContent("no re");
    expect(rows[1]).toHaveAttribute("data-message-id", "msg-2");
    expect(rows[1]).toHaveTextContent("so real");
    expect(rows[1]).toHaveTextContent("激しく同意");
  });

  it("語句(dt)はゴールドの強調色(text-pickup)で表示する(issue #87)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "good game の略、お疲れ" }] } },
    });

    render(<ChannelPage />);

    // 「チャットから拾い上げた語彙」が目に留まるよう、語句だけをゴールドで強調する
    const term = within(screen.getByRole("region", { name: "Pick up" })).getByText("gg");
    expect(term.className).toContain("text-pickup");
  });

  it("該当する表現が無い行は、行自体は描画しつつ中身を空にする(「None」を出さない)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "done", terms: [] } } });

    render(<ChannelPage />);

    // 3カラムの行対応(subgrid)を保つため、行そのものは存在し続けることを確認する
    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    const row = within(pickupColumn).getByRole("listitem");
    expect(row).toHaveAttribute("data-message-id", "msg-1");
    expect(row.textContent).toBe("");
    expect(within(pickupColumn).queryByText("None")).not.toBeInTheDocument();
  });

  it("生成中の行は「抽出中」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "pending" } } });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Extracting...")).toBeInTheDocument();
  });

  it("失敗した行は理由付きで「抽出に失敗」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText(/Extraction failed/)).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();
  });

  it("キュー溢れで破棄された行は「未抽出(流量超過)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "dropped" } } });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Not extracted (too many messages)")).toBeInTheDocument();
  });

  it("Prompt API が利用できない環境では、行ごとに「抽出不可」と表示し、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });
    usePickupStore.setState({ entries: { "msg-1": { status: "unavailable" } } });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("Extraction unavailable")).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("ID を持たない発言の行は「未抽出(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    usePickupStore.setState({ entries: {} });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Not extracted (no message ID)")).toBeInTheDocument();
  });

  it("Pick upのぼかしを入れるとPick up列の各行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "お疲れ" }] } } });

    render(<ChannelPage />);

    const row = within(screen.getByRole("region", { name: "Pick up" })).getByRole("listitem");
    expect(row).not.toHaveClass("blur-sm");

    const toggle = screen.getByRole("switch", { name: "Blur Pick up" });
    await user.click(toggle);
    expect(row).toHaveClass("blur-sm");
    // ぼかし中は語句の削除ボタンにフォーカスが移らず、読み上げでも語句が漏れないようにする
    expect(row).toHaveAttribute("inert");
    expect(within(row).getByRole("button", { name: 'Remove "gg"', hidden: true })).toBeInTheDocument();

    await user.click(toggle);
    expect(row).not.toHaveClass("blur-sm");
    expect(row).not.toHaveAttribute("inert");
  });

  it("語句の削除ボタンを押すと、その語句だけが表示から消える", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          terms: [
            { term: "gg", meaning: "good game の略、お疲れ" },
            { term: "no re", meaning: "再戦なし" },
          ],
        },
      },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    expect(within(pickupColumn).queryByText("gg")).not.toBeInTheDocument();
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
  });

  it("すべての語句を削除した行は何も表示しない(「None」を出さない)", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "お疲れ" }] } },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    expect(within(pickupColumn).queryByText("gg")).not.toBeInTheDocument();
    expect(within(pickupColumn).queryByText("None")).not.toBeInTheDocument();
  });


  it("語句を削除すると、同じ発言の次の語句の削除ボタンへフォーカスが移る", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          terms: [
            { term: "gg", meaning: "good game の略、お疲れ" },
            { term: "no re", meaning: "再戦なし" },
          ],
        },
      },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    expect(within(pickupColumn).getByRole("button", { name: 'Remove "no re"' })).toHaveFocus();
  });

  it("末尾の語句を削除すると、同じ発言の前の語句の削除ボタンへフォーカスが移る", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          terms: [
            { term: "gg", meaning: "good game の略、お疲れ" },
            { term: "no re", meaning: "再戦なし" },
          ],
        },
      },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "no re"' }));

    expect(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' })).toHaveFocus();
  });

  it("最後の語句を削除すると、行コンテナへフォーカスが移る", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "お疲れ" }] } },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    const row = within(pickupColumn).getByRole("listitem");
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    expect(row).toHaveFocus();
  });

  it('語句を削除すると、スクリーンリーダー向けの通知リージョンに「Removed "<語句>"」が表示される', async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "お疲れ" }] } },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    expect(screen.getByRole("status", { name: "Pick up updates" })).toHaveTextContent('Removed "gg"');
  });

  it("パイプライン再起動でエントリが再生成されても、削除した語句は表示されない", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: {
        "msg-1": {
          status: "done",
          terms: [
            { term: "gg", meaning: "good game の略、お疲れ" },
            { term: "no re", meaning: "再戦なし" },
          ],
        },
      },
    });

    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "gg"' }));

    // 言語設定変更・配信情報変化時の再起動を模す: エントリを破棄してから抽出結果を再生成する。
    // LLM の再実行では同じ語句でも綴り(大文字小文字・前後空白)が揺れ得るため、揺れた綴りで再生成する
    act(() => {
      usePickupStore.setState({ entries: {} });
      usePickupStore.setState({
        entries: {
          "msg-1": {
            status: "done",
            terms: [
              { term: " GG ", meaning: "good game の略、お疲れ" },
              { term: "no re", meaning: "再戦なし" },
            ],
          },
        },
      });
    });

    expect(within(pickupColumn).queryByText(/gg/i)).not.toBeInTheDocument();
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
  });
});

describe("ChannelPage(新着への追従)", () => {
  /**
   * jsdom はレイアウトを計算しないため scrollHeight が常に 0 になる。
   * スクロール先を検証できるよう、スクロール領域のビューポートに scrollHeight を固定値で与える
   */
  function スクロール領域のビューポートを用意する(scrollHeight: number, clientHeight = 500): HTMLElement {
    const viewport = document.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!viewport) throw new Error("スクロール領域のビューポートが見つかりません");
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: scrollHeight });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: clientHeight });
    return viewport;
  }

  it("生IRC列の見出しに追従トグルがあり、初期状態でオンになっている", () => {
    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    const toggle = within(rawColumn).getByRole("switch", { name: "Follow new messages" });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle.querySelector(".lucide-chevrons-down")).not.toBeNull();
  });

  it("利用者が上方向へスクロールして最下部から離れると、追従が自動でオフになる", () => {
    render(<ChannelPage />);
    const viewport = スクロール領域のビューポートを用意する(1000, 500);
    const toggle = screen.getByRole("switch", { name: "Follow new messages" });

    // 最下部(1000 - 500 = 500)から離れた位置へスクロールする
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);

    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("最下部に留まったままのスクロールイベントでは、追従はオンのまま", () => {
    render(<ChannelPage />);
    const viewport = スクロール領域のビューポートを用意する(1000, 500);
    const toggle = screen.getByRole("switch", { name: "Follow new messages" });

    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);

    expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  it("追従がオンのとき、発言が増えるとスクロール領域を最下部まで送る", () => {
    render(<ChannelPage />);
    const viewport = スクロール領域のビューポートを用意する(1000);
    viewport.scrollTop = 0;

    act(() => {
      useChatConnectionStore.setState({ messages: [サンプル発言] });
    });

    expect(viewport.scrollTop).toBe(1000);
  });

  it("追従をオフにすると、発言が増えてもスクロール位置を動かさない", async () => {
    const user = userEvent.setup();
    render(<ChannelPage />);
    const viewport = スクロール領域のビューポートを用意する(1000);

    const toggle = screen.getByRole("switch", { name: "Follow new messages" });
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    viewport.scrollTop = 0;

    act(() => {
      useChatConnectionStore.setState({ messages: [サンプル発言] });
    });

    expect(viewport.scrollTop).toBe(0);
  });

  it("追従をオフからオンに戻した時点で、最下部まで送る", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    render(<ChannelPage />);
    const viewport = スクロール領域のビューポートを用意する(1000);

    const toggle = screen.getByRole("switch", { name: "Follow new messages" });
    await user.click(toggle);
    viewport.scrollTop = 0;

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(viewport.scrollTop).toBe(1000);
  });
});

describe("ChannelPage(bot除外設定)", () => {
  it("生IRC列の見出しにある bot除外設定ボタンから、現在のパターンが入った入力欄を開ける", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns(["nightbot", "*trans"]);
    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    await user.click(within(rawColumn).getByRole("button", { name: "Bot filter" }));

    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    expect(within(dialog).getByRole("textbox", { name: "Usernames to hide" })).toHaveValue("nightbot\n*trans");
  });

  it("パターンを編集して保存すると、ストアに反映され LocalStorage にも保存される", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns([]);
    render(<ChannelPage />);

    await user.click(screen.getByRole("button", { name: "Bot filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    const textbox = within(dialog).getByRole("textbox", { name: "Usernames to hide" });
    await user.clear(textbox);
    await user.type(textbox, "StreamElements{enter}*bot");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(useBotFilterStore.getState().patterns).toEqual(["streamelements", "*bot"]);
    expect(JSON.parse(window.localStorage.getItem("chat-sensei:bot-filter") ?? "null")).toEqual({
      patterns: ["streamelements", "*bot"],
      excludeBroadcaster: false,
    });
  });

  it("配信者自身の発言を隠すトグルを切り替えて保存すると、ストアと LocalStorage に反映される", async () => {
    const user = userEvent.setup();
    render(<ChannelPage />);

    await user.click(screen.getByRole("button", { name: "Bot filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    const toggle = within(dialog).getByRole("switch", { name: "Hide the streamer's own messages" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await user.click(toggle);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(useBotFilterStore.getState().excludeBroadcaster).toBe(true);
    expect(JSON.parse(window.localStorage.getItem("chat-sensei:bot-filter") ?? "null")).toMatchObject({
      excludeBroadcaster: true,
    });
  });

  it("マウント時に LocalStorage から除外パターンを復元する", () => {
    window.localStorage.setItem("chat-sensei:bot-filter", JSON.stringify(["custom_bot"]));

    render(<ChannelPage />);

    expect(useBotFilterStore.getState().patterns).toEqual(["custom_bot"]);
  });

  it("保存データが壊れていた場合は、入力欄にデフォルトへ戻した旨を表示する", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("chat-sensei:bot-filter", "壊れたデータ");
    render(<ChannelPage />);

    await user.click(screen.getByRole("button", { name: "Bot filter" }));

    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    expect(within(dialog).getByText(/reset to the defaults/)).toBeInTheDocument();
  });
});

describe("ChannelPage(Prompt API の利用可否)", () => {
  it("利用不可の理由は共有の prompt-api ストアから取り、翻訳列と Pick up 列の両方の見出し付近に同じ理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });

    render(<ChannelPage />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(translationColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
    // エントリが無い行も、共有の状態を見て両列とも「不可」になる
    expect(within(translationColumn).getByText("Translation unavailable")).toBeInTheDocument();
    expect(within(pickupColumn).getByText("Extraction unavailable")).toBeInTheDocument();
  });

  it("診断中は両列とも「準備中...」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<ChannelPage />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Preparing...")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Preparing...")).toBeInTheDocument();
  });
});

describe("ChannelPage(設定ダイアログ)", () => {
  it("設定ダイアログはヘッダー(SiteHeader)へ移したため、ページ内には設定ボタンを置かない", () => {
    render(<ChannelPage />);

    expect(screen.queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("マウント時に LocalStorage から言語設定を復元してから、パイプラインを開始する", () => {
    window.localStorage.setItem("chat-sensei:settings", JSON.stringify({ learningLang: "fr", explainLang: "ja" }));

    render(<ChannelPage />);

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "fr", explainLang: "ja" });
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("ChannelPage(言語ペアの設定)", () => {
  it("言語ペアのセレクトはヘッダー(SiteHeader)へ移したため、ページ内には置かない", () => {
    render(<ChannelPage />);

    expect(screen.queryByRole("combobox", { name: "Learning language" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Explanation language" })).not.toBeInTheDocument();
  });

  it("学ぶ言語を変更すると、翻訳・Pick up のパイプラインを停止して新しい設定で開始し直す", () => {
    render(<ChannelPage />);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);

    // 言語ペアのセレクトはヘッダーへ移したため、設定変更はストア経由で注入する
    act(() => {
      useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, learningLang: "de" });
    });

    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
    expect(mockStopPickupPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(2);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(2);
  });

  it("解説言語を変更すると、翻訳・Pick up のパイプラインを停止して新しい設定で開始し直す", () => {
    render(<ChannelPage />);

    act(() => {
      useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, explainLang: "fr" });
    });

    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
    expect(mockStopPickupPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(2);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(2);
  });

  it("列見出しには言語設定のダイアログを置かない(接続フォーム横のセレクトに一本化)", () => {
    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    const translationColumn = screen.getByRole("region", { name: "Translation" });
    expect(within(rawColumn).queryByRole("button", { name: "Learning languages" })).not.toBeInTheDocument();
    expect(within(translationColumn).queryByRole("button", { name: "Explanation language" })).not.toBeInTheDocument();
  });
});

describe("ChannelPage(言語判定でスキップした行)", () => {
  it("学ぶ言語ではない行は、判定した言語コードを添えて「Not a learning language」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "other-language", detectedLanguage: "ko" } } });
    usePickupStore.setState({ entries: { "msg-1": { status: "other-language", detectedLanguage: "ko" } } });

    render(<ChannelPage />);

    expect(
      within(screen.getByRole("region", { name: "Translation" })).getByText("Not a learning language (ko)"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Pick up" })).getByText("Not a learning language (ko)"),
    ).toBeInTheDocument();
  });
});

describe("ChannelPage(手動Pick up。issue #72)", () => {
  it("手動Pick upの完了した語句と意味を、Pick up列の対応する行に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useManualPickupStore.setState({
      entries: { "msg-1": [{ status: "done", term: "no re", meaning: "リマッチは無しという挨拶" }] },
    });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
    expect(within(pickupColumn).getByText("リマッチは無しという挨拶")).toBeInTheDocument();
  });

  it("自動抽出の結果が空でも手動Pick upがあれば表示し、「None」は表示しない", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "done", terms: [] } } });
    useManualPickupStore.setState({
      entries: { "msg-1": [{ status: "done", term: "no re", meaning: "リマッチは無しという挨拶" }] },
    });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
    expect(within(pickupColumn).queryByText("None")).not.toBeInTheDocument();
  });

  it("自動抽出が生成中の行でも、手動Pick upは並行して表示する(暗黙に隠さない)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "pending" } } });
    useManualPickupStore.setState({
      entries: { "msg-1": [{ status: "done", term: "no re", meaning: "リマッチは無しという挨拶" }] },
    });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("Extracting...")).toBeInTheDocument();
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
  });

  it("生成中の手動Pick upは「Looking up...」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useManualPickupStore.setState({ entries: { "msg-1": [{ status: "pending", term: "no re" }] } });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
    expect(within(pickupColumn).getByText("Looking up...")).toBeInTheDocument();
  });

  it("失敗した手動Pick upは理由付きで表示する(暗黙に隠さない)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useManualPickupStore.setState({
      entries: { "msg-1": [{ status: "failed", term: "no re", reason: "モデル呼び出しに失敗しました" }] },
    });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("no re")).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/Lookup failed: モデル呼び出しに失敗しました/)).toBeInTheDocument();
  });

  it("手動Pick upの削除ボタンを押すと、その語句がストアからも表示からも消える", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useManualPickupStore.setState({
      entries: { "msg-1": [{ status: "done", term: "no re", meaning: "リマッチは無しという挨拶" }] },
    });
    render(<ChannelPage />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    await user.click(within(pickupColumn).getByRole("button", { name: 'Remove "no re"' }));

    expect(within(pickupColumn).queryByText("no re")).not.toBeInTheDocument();
    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("生IRC列の発言行を範囲選択して「Pick up」を押すと、発言本文付きで手動Pick upを追加する", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    render(<ChannelPage />);

    const rawColumn = screen.getByRole("region", { name: "Raw Chat" });
    const textNode = within(rawColumn).getByText("gg no re chat").firstChild;
    if (!textNode) throw new Error("発言本文のテキストノードが見つかりません");
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.setEnd(textNode, 8); // "no re"
    const selection = document.getSelection();
    if (!selection) throw new Error("jsdom で Selection が取得できませんでした");
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent(document, new Event("selectionchange"));

    await user.click(screen.getByRole("button", { name: "Pick up" }));

    expect(mockAddManualPickup).toHaveBeenCalledWith("msg-1", "no re", "gg no re chat");
  });
});

describe("ChannelPage(接続中の配信embedと配信者情報)", () => {
  it("接続中は接続中チャンネルの配信embed(Twitchプレイヤーのiframe)を表示する", () => {
    render(<ChannelPage />);

    expect(screen.getByTitle("Twitch player: example")).toBeInTheDocument();
  });

  it("接続中は配信者情報パネル(Stream info)を表示し、チャンネル入力・Connect ボタンは表示しない", () => {
    render(<ChannelPage />);

    expect(screen.getByRole("complementary", { name: "Stream info" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Channel")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).not.toBeInTheDocument();
  });

  it("配信者情報パネルに Disconnect ボタンは表示しない(切断はヘッダーのロゴクリックで行う)", () => {
    render(<ChannelPage />);

    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });
});

describe("ChannelPage(URLルーティング)", () => {
  it("未接続の状態でマウントすると、URLのチャンネル名(正規化済み)で connect を呼ぶ(直接アクセス対応)", () => {
    const connectMock = vi.fn();
    // /Example_Streamer に直接アクセスした状態(大文字は正規化されて接続される)
    mockChannelParam = "Example_Streamer";
    useChatConnectionStore.setState({ connectionState: "idle", channel: "example_streamer", connect: connectMock });

    render(<ChannelPage />);

    expect(connectMock).toHaveBeenCalledWith("example_streamer");
  });

  it("既にURLと同じチャンネルへ接続中なら、マウントしても connect を呼び直さない", () => {
    const connectMock = vi.fn();
    useChatConnectionStore.setState({ connectionState: "open", channel: "example", connect: connectMock });

    render(<ChannelPage />);

    expect(connectMock).not.toHaveBeenCalled();
  });

  it("接続中のチャンネルとURLのチャンネルが異なる場合は、URLのチャンネルへ接続し直す", () => {
    const connectMock = vi.fn();
    // ストアは example に接続中だが、URL は /another_streamer を表示している
    mockChannelParam = "another_streamer";
    useChatConnectionStore.setState({ connectionState: "open", channel: "example", connect: connectMock });

    render(<ChannelPage />);

    expect(connectMock).toHaveBeenCalledWith("another_streamer");
  });

  it("切断(channel が null)されたらホーム(/)へ遷移する", () => {
    render(<ChannelPage />);
    expect(mockRouterReplace).not.toHaveBeenCalled();

    // Disconnect 相当: 実装(chat-connection ストア)は切断時に channel を null に戻す
    act(() => {
      useChatConnectionStore.setState({ connectionState: "closed", channel: null });
    });

    expect(mockRouterReplace).toHaveBeenCalledWith("/");
  });
});
