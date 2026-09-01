/**
 * src/app/page.tsx(ホーム = 3カラムのチャット閲覧画面)のテスト。
 *
 * 生IRC / 翻訳 / 解説 の3列が描画されること、受信済み発言が生IRC列に
 * 表示されること、翻訳列に発言ごとの翻訳状態が表示されること、
 * 翻訳列・解説列のぼかしをトグルで切り替えられることを検証する。
 * IRC 接続そのものは chat-connection ストアに、翻訳の生成は translations ストアに
 * 閉じているため、ここでは各ストアの state を直接書き換えて注入する。
 * 翻訳パイプラインの開始(`startTranslationPipeline`)はブラウザAPIに触れるためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { resetBotFilterStoreForTests, useBotFilterStore } from "@/store/bot-filter";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetTranslationStoreForTests, useTranslationStore } from "@/store/translations";

const mockStopPipeline = vi.fn();
const mockStartTranslationPipeline = vi.fn(() => mockStopPipeline);
const mockWarmUpTranslationPipeline = vi.fn();

vi.mock("@/store/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/translations")>()),
  startTranslationPipeline: () => mockStartTranslationPipeline(),
  warmUpTranslationPipeline: () => mockWarmUpTranslationPipeline(),
}));

import Home from "./page";

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
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetTranslationStoreForTests();
  resetBotFilterStoreForTests();
  window.localStorage.clear();
});

describe("Home(3カラム構成)", () => {
  it("生IRC・翻訳・解説の3列を見出し付きで表示する", () => {
    render(<Home />);

    expect(screen.getByRole("region", { name: "生IRC" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "翻訳" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "解説" })).toBeInTheDocument();
  });

  it("受信済みの発言を生IRC列に表示名付きで表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<Home />);

    const rawColumn = screen.getByRole("region", { name: "生IRC" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(within(rawColumn).getByText("gg no re chat")).toBeInTheDocument();
  });

  it("翻訳列と解説列は初期状態でぼかされており、トグルで解除できる", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "翻訳" });
    const explanationColumn = screen.getByRole("region", { name: "解説" });
    expect(translationColumn).toHaveAttribute("data-blurred", "true");
    expect(explanationColumn).toHaveAttribute("data-blurred", "true");

    await user.click(screen.getByRole("switch", { name: "翻訳をぼかす" }));
    expect(translationColumn).toHaveAttribute("data-blurred", "false");
    expect(explanationColumn).toHaveAttribute("data-blurred", "true");

    await user.click(screen.getByRole("switch", { name: "解説をぼかす" }));
    expect(explanationColumn).toHaveAttribute("data-blurred", "false");
  });

  it("「接続する」クリック(ユーザー操作)の延長で翻訳セッションをウォームアップする(モデルDLにユーザー操作が必要なため)", async () => {
    const user = userEvent.setup();
    // 実際の IRC 接続(WebSocket)は行わない
    useChatConnectionStore.setState({ connect: vi.fn() });
    render(<Home />);

    await user.type(screen.getByLabelText("チャンネル名"), "example");
    await user.click(screen.getByRole("button", { name: "接続する" }));

    expect(mockWarmUpTranslationPipeline).toHaveBeenCalledTimes(1);
  });

  it("マウント時に翻訳パイプラインを開始し、アンマウント時に停止する", () => {
    const { unmount } = render(<Home />);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("Home(翻訳列)", () => {
  it("完了した翻訳を、対応する発言と同じ順序で翻訳列に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    useTranslationStore.setState({
      promptApi: { status: "ready" },
      entries: {
        "msg-1": { status: "done", translation: "ナイスゲーム、再戦なし、チャット" },
        "msg-2": { status: "done", translation: "これはマジでそう" },
      },
    });

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "翻訳" });
    const rows = within(translationColumn).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("ナイスゲーム、再戦なし、チャット");
    expect(rows[1]).toHaveTextContent("これはマジでそう");
  });

  it("翻訳列の各行は対応する発言の ID と紐づく(行の高さを左列と揃えるための共通キー)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      promptApi: { status: "ready" },
      entries: { "msg-1": { status: "done", translation: "訳文" } },
    });

    render(<Home />);

    const rawRow = within(screen.getByRole("region", { name: "生IRC" })).getByRole("listitem");
    const translationRow = within(screen.getByRole("region", { name: "翻訳" })).getByRole("listitem");
    expect(rawRow).toHaveAttribute("data-message-id", "msg-1");
    expect(translationRow).toHaveAttribute("data-message-id", "msg-1");
  });

  it("生成中の行は「翻訳中」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ promptApi: { status: "ready" }, entries: { "msg-1": { status: "pending" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "翻訳" })).getByText("翻訳中...")).toBeInTheDocument();
  });

  it("失敗した行は理由付きで「翻訳に失敗」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      promptApi: { status: "ready" },
      entries: { "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } },
    });

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "翻訳" });
    expect(within(translationColumn).getByText(/翻訳に失敗/)).toBeInTheDocument();
    expect(within(translationColumn).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();
  });

  it("キュー溢れで破棄された行は「未翻訳(流量超過)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ promptApi: { status: "ready" }, entries: { "msg-1": { status: "dropped" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "翻訳" })).getByText("未翻訳(流量超過)")).toBeInTheDocument();
  });

  it("Prompt API が利用できない環境では、行ごとに「翻訳不可」と表示し、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      promptApi: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
      entries: { "msg-1": { status: "unavailable" } },
    });

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "翻訳" });
    expect(within(translationColumn).getByText("翻訳不可")).toBeInTheDocument();
    expect(within(translationColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("ID を持たない発言の行は「未翻訳(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    useTranslationStore.setState({ promptApi: { status: "ready" }, entries: {} });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "翻訳" })).getByText("未翻訳(IDなし)")).toBeInTheDocument();
  });

  it("翻訳をぼかしている間は翻訳列の各行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      promptApi: { status: "ready" },
      entries: { "msg-1": { status: "done", translation: "訳文" } },
    });

    render(<Home />);

    const translationRow = within(screen.getByRole("region", { name: "翻訳" })).getByRole("listitem");
    expect(translationRow).toHaveClass("blur-sm");

    await user.click(screen.getByRole("switch", { name: "翻訳をぼかす" }));
    expect(translationRow).not.toHaveClass("blur-sm");
  });
});

describe("Home(bot除外設定)", () => {
  it("生IRC列の見出しにある bot除外設定ボタンから、現在のパターンが入った入力欄を開ける", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns(["nightbot", "*trans"]);
    render(<Home />);

    const rawColumn = screen.getByRole("region", { name: "生IRC" });
    await user.click(within(rawColumn).getByRole("button", { name: "bot除外設定" }));

    const dialog = await screen.findByRole("dialog", { name: "bot除外設定" });
    expect(within(dialog).getByRole("textbox", { name: "除外するユーザー名" })).toHaveValue("nightbot\n*trans");
  });

  it("パターンを編集して保存すると、ストアに反映され LocalStorage にも保存される", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns([]);
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "bot除外設定" }));
    const dialog = await screen.findByRole("dialog", { name: "bot除外設定" });
    const textbox = within(dialog).getByRole("textbox", { name: "除外するユーザー名" });
    await user.clear(textbox);
    await user.type(textbox, "StreamElements{enter}*bot");
    await user.click(within(dialog).getByRole("button", { name: "保存する" }));

    expect(useBotFilterStore.getState().patterns).toEqual(["streamelements", "*bot"]);
    expect(JSON.parse(window.localStorage.getItem("chat-sensei:bot-filter") ?? "null")).toEqual([
      "streamelements",
      "*bot",
    ]);
  });

  it("マウント時に LocalStorage から除外パターンを復元する", () => {
    window.localStorage.setItem("chat-sensei:bot-filter", JSON.stringify(["custom_bot"]));

    render(<Home />);

    expect(useBotFilterStore.getState().patterns).toEqual(["custom_bot"]);
  });

  it("保存データが壊れていた場合は、入力欄にデフォルトへ戻した旨を表示する", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("chat-sensei:bot-filter", "壊れたデータ");
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "bot除外設定" }));

    const dialog = await screen.findByRole("dialog", { name: "bot除外設定" });
    expect(within(dialog).getByText(/デフォルトに戻しました/)).toBeInTheDocument();
  });
});
