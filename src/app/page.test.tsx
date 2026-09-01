/**
 * src/app/page.tsx(ホーム = 3カラムのチャット閲覧画面)のテスト。
 *
 * 生IRC / 翻訳 / 解説 の3列が描画されること、受信済み発言が生IRC列に
 * 表示されること、翻訳列に発言ごとの翻訳状態が表示されること、解説列で「解説」ボタンから
 * 解説を要求でき発言ごとの解説状態が表示されること、翻訳列・解説列のぼかしをトグルで
 * 切り替えられることを検証する。
 * IRC 接続そのものは chat-connection ストアに、翻訳の生成は translations ストアに、
 * 解説の生成は explanations ストアに閉じているため、ここでは各ストアの state を直接書き換えて注入する。
 * 各パイプラインの開始(`startTranslationPipeline` / `startExplanationPipeline`)は
 * ブラウザAPIに触れるためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { resetBotFilterStoreForTests, useBotFilterStore } from "@/store/bot-filter";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetTranslationStoreForTests, useTranslationStore } from "@/store/translations";
import { resetExplanationStoreForTests, useExplanationStore, type ExplanationEntry } from "@/store/explanations";

const mockStopPipeline = vi.fn();
const mockStartTranslationPipeline = vi.fn(() => mockStopPipeline);
const mockWarmUpTranslationPipeline = vi.fn();

vi.mock("@/store/translations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/translations")>()),
  startTranslationPipeline: () => mockStartTranslationPipeline(),
  warmUpTranslationPipeline: () => mockWarmUpTranslationPipeline(),
}));

const mockStopExplanationPipeline = vi.fn();
const mockStartExplanationPipeline = vi.fn(() => mockStopExplanationPipeline);
const mockRequestExplanation = vi.fn();

vi.mock("@/store/explanations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/store/explanations")>()),
  startExplanationPipeline: () => mockStartExplanationPipeline(),
  requestExplanation: (message: TwitchChatMessage) => mockRequestExplanation(message),
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
  mockStartExplanationPipeline.mockClear();
  mockStopExplanationPipeline.mockClear();
  mockRequestExplanation.mockClear();
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetTranslationStoreForTests();
  resetExplanationStoreForTests();
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

describe("Home(解説列)", () => {
  /** 解説列のテストで使う、Prompt API が使える状態の解説ストア */
  function setExplanationReady(entries: Record<string, ExplanationEntry> = {}) {
    useExplanationStore.setState({ promptApi: { status: "ready" }, entries });
  }

  it("マウント時に解説パイプラインを開始し、アンマウント時に停止する", () => {
    const { unmount } = render(<Home />);
    expect(mockStartExplanationPipeline).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockStopExplanationPipeline).toHaveBeenCalledTimes(1);
  });

  it("未要求の行には「解説」ボタンがあり、クリックすると対応する発言の解説を要求する", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    setExplanationReady();

    render(<Home />);

    const rows = within(screen.getByRole("region", { name: "解説" })).getAllByRole("listitem");
    await user.click(within(rows[1]).getByRole("button", { name: "解説" }));

    expect(mockRequestExplanation).toHaveBeenCalledTimes(1);
    expect(mockRequestExplanation).toHaveBeenCalledWith(サンプル発言2);
  });

  it("解説をぼかしていても「解説」ボタンはぼかしの外にあり操作できる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    setExplanationReady();

    render(<Home />);

    expect(screen.getByRole("switch", { name: "解説をぼかす" })).toBeChecked();
    const button = within(screen.getByRole("region", { name: "解説" })).getByRole("button", { name: "解説" });
    expect(button.closest(".blur-sm")).toBeNull();

    await user.click(button);
    expect(mockRequestExplanation).toHaveBeenCalledWith(サンプル発言);
  });

  it("生成中の行は「解説中」と表示し、ボタンは出さない", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    setExplanationReady({ "msg-1": { status: "pending" } });

    render(<Home />);

    const column = screen.getByRole("region", { name: "解説" });
    expect(within(column).getByText("解説中...")).toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: "解説" })).not.toBeInTheDocument();
  });

  it("完了した解説を対応する発言の行に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    setExplanationReady({
      "msg-2": {
        status: "done",
        result: {
          translation: "これはマジでそう",
          literal: "これはとても本物だ",
          items: [{ term: "so real", kind: "slang", meaning: "激しく同意", note: "共感を示す若者言葉" }],
          difficulty: 3,
        },
      },
    });

    render(<Home />);

    const rows = within(screen.getByRole("region", { name: "解説" })).getAllByRole("listitem");
    expect(rows[0]).toHaveAttribute("data-message-id", "msg-1");
    expect(within(rows[0]).getByRole("button", { name: "解説" })).toBeInTheDocument();
    expect(rows[1]).toHaveAttribute("data-message-id", "msg-2");
    expect(rows[1]).toHaveTextContent("これはマジでそう");
    expect(rows[1]).toHaveTextContent("so real");
    expect(rows[1]).toHaveTextContent("難易度 3/5");
  });

  it("失敗した行は理由付きで「解説に失敗」と表示し、「再試行」ボタンで再要求できる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    setExplanationReady({ "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } });

    render(<Home />);

    const column = screen.getByRole("region", { name: "解説" });
    expect(within(column).getByText(/解説に失敗/)).toBeInTheDocument();
    expect(within(column).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();

    await user.click(within(column).getByRole("button", { name: "再試行" }));
    expect(mockRequestExplanation).toHaveBeenCalledWith(サンプル発言);
  });

  it("Prompt API が利用できない環境では、行ごとに「解説不可」と表示してボタンを出さず、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useExplanationStore.setState({
      promptApi: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
      entries: {},
    });

    render(<Home />);

    const column = screen.getByRole("region", { name: "解説" });
    expect(within(column).getByText("解説不可")).toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: "解説" })).not.toBeInTheDocument();
    expect(within(column).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("環境診断が終わるまでは「準備中」の無効なボタンを表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useExplanationStore.setState({ promptApi: { status: "checking" }, entries: {} });

    render(<Home />);

    const column = screen.getByRole("region", { name: "解説" });
    expect(within(column).getByRole("button", { name: "準備中..." })).toBeDisabled();
  });

  it("ID を持たない発言の行は「解説不可(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    setExplanationReady();

    render(<Home />);

    const column = screen.getByRole("region", { name: "解説" });
    expect(within(column).getByText("解説不可(IDなし)")).toBeInTheDocument();
    expect(within(column).queryByRole("button", { name: "解説" })).not.toBeInTheDocument();
  });

  it("解説をぼかしている間は完了した解説の行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    setExplanationReady({
      "msg-1": { status: "done", result: { translation: "訳", literal: "直訳", items: [], difficulty: 1 } },
    });

    render(<Home />);

    const row = within(screen.getByRole("region", { name: "解説" })).getByRole("listitem");
    expect(row).toHaveClass("blur-sm");

    await user.click(screen.getByRole("switch", { name: "解説をぼかす" }));
    expect(row).not.toHaveClass("blur-sm");
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
