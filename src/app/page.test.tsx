/**
 * src/app/page.tsx(ホーム = 3カラムのチャット閲覧画面)のテスト。
 *
 * 生IRC / 翻訳 / Pick up の3列が描画されること、受信済み発言が生IRC列に
 * 表示されること、翻訳列・Pick up列に発言ごとの状態が表示されること、
 * 翻訳列・Pick up列のぼかしをトグルで切り替えられることを検証する。
 * IRC 接続そのものは chat-connection ストアに、翻訳の生成は translations ストアに、
 * 注目の表現の抽出は pickups ストアに、Prompt API の利用可否は prompt-api ストアに閉じているため、
 * ここでは各ストアの state を直接書き換えて注入する。
 * 各パイプラインの開始(`startTranslationPipeline` / `startPickupPipeline`)はブラウザAPIに触れるためモックする。
 * 設定ダイアログの環境診断(`runBrowserDiagnosis`)も同様にモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { resetBotFilterStoreForTests, useBotFilterStore } from "@/store/bot-filter";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import { resetPickupStoreForTests, usePickupStore } from "@/store/pickups";
import { resetPromptApiStoreForTests, usePromptApiStore } from "@/store/prompt-api";
import { resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";
import { resetTranslationStoreForTests, useTranslationStore } from "@/store/translations";

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

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: () => new Promise(() => {}),
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
  mockStartPickupPipeline.mockClear();
  mockStopPickupPipeline.mockClear();
  mockWarmUpPickupPipeline.mockClear();
});

afterEach(() => {
  resetChatConnectionStoreForTests();
  resetTranslationStoreForTests();
  resetPickupStoreForTests();
  resetPromptApiStoreForTests();
  resetBotFilterStoreForTests();
  resetSettingsStoreForTests();
  window.localStorage.clear();
});

describe("Home(3カラム構成)", () => {
  it("生IRC・翻訳・Pick upの3列を見出し付きで表示する", () => {
    render(<Home />);

    expect(screen.getByRole("region", { name: "Raw IRC" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Translation" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pick up" })).toBeInTheDocument();
  });

  it("受信済みの発言を生IRC列に表示名付きで表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<Home />);

    const rawColumn = screen.getByRole("region", { name: "Raw IRC" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(within(rawColumn).getByText("gg no re chat")).toBeInTheDocument();
  });

  it("翻訳列とPick up列は初期状態でぼかされており、トグルで解除できる", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(translationColumn).toHaveAttribute("data-blurred", "true");
    expect(pickupColumn).toHaveAttribute("data-blurred", "true");

    // トグルは各列の見出し(ヘッダー)内に目のアイコンとして置く
    const translationToggle = within(translationColumn).getByRole("switch", { name: "Blur translation" });
    const pickupToggle = within(pickupColumn).getByRole("switch", { name: "Blur Pick up" });
    expect(translationToggle).toHaveAttribute("aria-checked", "true");
    expect(pickupToggle).toHaveAttribute("aria-checked", "true");

    await user.click(translationToggle);
    expect(translationToggle).toHaveAttribute("aria-checked", "false");
    expect(translationColumn).toHaveAttribute("data-blurred", "false");
    expect(pickupColumn).toHaveAttribute("data-blurred", "true");

    await user.click(pickupToggle);
    expect(pickupToggle).toHaveAttribute("aria-checked", "false");
    expect(pickupColumn).toHaveAttribute("data-blurred", "false");
  });

  it("ぼかしトグルはぼかし中は EyeOff、解除中は Eye のアイコンを表示する", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const toggle = screen.getByRole("switch", { name: "Blur translation" });
    expect(toggle.querySelector(".lucide-eye-off")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye")).toBeNull();

    await user.click(toggle);
    expect(toggle.querySelector(".lucide-eye")).not.toBeNull();
    expect(toggle.querySelector(".lucide-eye-off")).toBeNull();
  });

  it("「接続する」クリック(ユーザー操作)の延長で翻訳・Pick upのセッションをウォームアップする(モデルDLにユーザー操作が必要なため)", async () =>  {
    const user = userEvent.setup();
    // 実際の IRC 接続(WebSocket)は行わない
    useChatConnectionStore.setState({ connect: vi.fn() });
    render(<Home />);

    await user.type(screen.getByLabelText("Channel"), "example");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(mockWarmUpTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockWarmUpPickupPipeline).toHaveBeenCalledTimes(1);
  });

  it("マウント時に翻訳・Pick upのパイプラインを開始し、アンマウント時に停止する", () => {
    const { unmount } = render(<Home />);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(1);

    unmount();
    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
    expect(mockStopPickupPipeline).toHaveBeenCalledTimes(1);
  });
});

describe("Home(翻訳列)", () => {
  it("完了した翻訳を、対応する発言と同じ順序で翻訳列に表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言, サンプル発言2] });
    useTranslationStore.setState({
      entries: {
        "msg-1": { status: "done", segments: [{ type: "text", text: "ナイスゲーム、再戦なし、チャット" }] },
        "msg-2": { status: "done", segments: [{ type: "text", text: "これはマジでそう" }] },
      },
    });

    render(<Home />);

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

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    const image = within(translationColumn).getByRole("img", { name: "sayuwuLul" });
    expect(image).toHaveAttribute("src", expect.stringContaining("/emotesv2_1/"));
    expect(within(translationColumn).queryByText(/sayuwuLul/)).not.toBeInTheDocument();
    expect(within(translationColumn).getByText("なんで")).toBeInTheDocument();
  });

  it("翻訳列の各行は対応する発言の ID と紐づく(行の高さを左列と揃えるための共通キー)", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "訳文" }] } } });

    render(<Home />);

    const rawRow = within(screen.getByRole("region", { name: "Raw IRC" })).getByRole("listitem");
    const translationRow = within(screen.getByRole("region", { name: "Translation" })).getByRole("listitem");
    expect(rawRow).toHaveAttribute("data-message-id", "msg-1");
    expect(translationRow).toHaveAttribute("data-message-id", "msg-1");
  });

  it("生成中の行は「翻訳中」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "pending" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Translating...")).toBeInTheDocument();
  });

  it("失敗した行は理由付きで「翻訳に失敗」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({
      entries: { "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } },
    });

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    expect(within(translationColumn).getByText(/Translation failed/)).toBeInTheDocument();
    expect(within(translationColumn).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();
  });

  it("キュー溢れで破棄された行は「未翻訳(流量超過)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "dropped" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Not translated (too many messages)")).toBeInTheDocument();
  });

  it("Prompt API が利用できない環境では、行ごとに「翻訳不可」と表示し、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });
    useTranslationStore.setState({ entries: { "msg-1": { status: "unavailable" } } });

    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "Translation" });
    expect(within(translationColumn).getByText("Translation unavailable")).toBeInTheDocument();
    expect(within(translationColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("ID を持たない発言の行は「未翻訳(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    useTranslationStore.setState({ entries: {} });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Not translated (no message ID)")).toBeInTheDocument();
  });

  it("翻訳をぼかしている間は翻訳列の各行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    useTranslationStore.setState({ entries: { "msg-1": { status: "done", segments: [{ type: "text", text: "訳文" }] } } });

    render(<Home />);

    const translationRow = within(screen.getByRole("region", { name: "Translation" })).getByRole("listitem");
    expect(translationRow).toHaveClass("blur-sm");

    await user.click(screen.getByRole("switch", { name: "Blur translation" }));
    expect(translationRow).not.toHaveClass("blur-sm");
  });
});

describe("Home(Pick up列)", () => {
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

    render(<Home />);

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

  it("該当する表現が無い行は「なし」と控えめに表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "done", terms: [] } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("None")).toBeInTheDocument();
  });

  it("生成中の行は「抽出中」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "pending" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Extracting...")).toBeInTheDocument();
  });

  it("失敗した行は理由付きで「抽出に失敗」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({
      entries: { "msg-1": { status: "failed", reason: "応答をJSONとして解釈できませんでした" } },
    });

    render(<Home />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText(/Extraction failed/)).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/応答をJSONとして解釈できませんでした/)).toBeInTheDocument();
  });

  it("キュー溢れで破棄された行は「未抽出(流量超過)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "dropped" } } });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Not extracted (too many messages)")).toBeInTheDocument();
  });

  it("Prompt API が利用できない環境では、行ごとに「抽出不可」と表示し、列の見出し付近に理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });
    usePickupStore.setState({ entries: { "msg-1": { status: "unavailable" } } });

    render(<Home />);

    const pickupColumn = screen.getByRole("region", { name: "Pick up" });
    expect(within(pickupColumn).getByText("Extraction unavailable")).toBeInTheDocument();
    expect(within(pickupColumn).getByText(/window\.LanguageModel/)).toBeInTheDocument();
  });

  it("ID を持たない発言の行は「未抽出(IDなし)」と表示する", () => {
    useChatConnectionStore.setState({ messages: [{ ...サンプル発言, id: null }] });
    usePickupStore.setState({ entries: {} });

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Not extracted (no message ID)")).toBeInTheDocument();
  });

  it("Pick upをぼかしている間はPick up列の各行がぼかされ、解除すると外れる", async () => {
    const user = userEvent.setup();
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePickupStore.setState({ entries: { "msg-1": { status: "done", terms: [{ term: "gg", meaning: "お疲れ" }] } } });

    render(<Home />);

    const row = within(screen.getByRole("region", { name: "Pick up" })).getByRole("listitem");
    expect(row).toHaveClass("blur-sm");

    await user.click(screen.getByRole("switch", { name: "Blur Pick up" }));
    expect(row).not.toHaveClass("blur-sm");
  });
});

describe("Home(bot除外設定)", () => {
  it("生IRC列の見出しにある bot除外設定ボタンから、現在のパターンが入った入力欄を開ける", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns(["nightbot", "*trans"]);
    render(<Home />);

    const rawColumn = screen.getByRole("region", { name: "Raw IRC" });
    await user.click(within(rawColumn).getByRole("button", { name: "Bot filter" }));

    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    expect(within(dialog).getByRole("textbox", { name: "Usernames to hide" })).toHaveValue("nightbot\n*trans");
  });

  it("パターンを編集して保存すると、ストアに反映され LocalStorage にも保存される", async () => {
    const user = userEvent.setup();
    useBotFilterStore.getState().setPatterns([]);
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "Bot filter" }));
    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    const textbox = within(dialog).getByRole("textbox", { name: "Usernames to hide" });
    await user.clear(textbox);
    await user.type(textbox, "StreamElements{enter}*bot");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

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

    await user.click(screen.getByRole("button", { name: "Bot filter" }));

    const dialog = await screen.findByRole("dialog", { name: "Bot filter" });
    expect(within(dialog).getByText(/reset to the defaults/)).toBeInTheDocument();
  });
});

describe("Home(Prompt API の利用可否)", () => {
  it("利用不可の理由は共有の prompt-api ストアから取り、翻訳列と Pick up 列の両方の見出し付近に同じ理由を表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });
    usePromptApiStore.setState({
      status: { status: "unavailable", reason: "この環境では Prompt API (window.LanguageModel) が見つかりません。" },
    });

    render(<Home />);

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

    render(<Home />);

    expect(within(screen.getByRole("region", { name: "Translation" })).getByText("Preparing...")).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Pick up" })).getByText("Preparing...")).toBeInTheDocument();
  });
});

describe("Home(設定ダイアログ)", () => {
  it("接続フォームの横にある設定ボタンから、言語ペアのセレクトが入った設定ダイアログを開ける", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem("chat-sensei:settings", JSON.stringify({ targetLang: "es", explainLang: "en" }));
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "Settings" }));

    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    expect(within(dialog).getByRole("combobox", { name: "Learning language" })).toHaveValue("es");
    expect(within(dialog).getByRole("combobox", { name: "Explanation language" })).toHaveValue("en");
  });

  it("マウント時に LocalStorage から言語ペアを復元してから、パイプラインを開始する", () => {
    window.localStorage.setItem("chat-sensei:settings", JSON.stringify({ targetLang: "fr", explainLang: "ja" }));

    render(<Home />);

    expect(useSettingsStore.getState().settings).toEqual({ targetLang: "fr", explainLang: "ja" });
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(1);
  });

  it("言語ペアを変更して保存すると、翻訳・Pick up のパイプラインを停止して新しい言語ペアで開始し直す", async () => {
    const user = userEvent.setup();
    render(<Home />);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Learning language" }), "de");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(mockStopPipeline).toHaveBeenCalledTimes(1);
    expect(mockStopPickupPipeline).toHaveBeenCalledTimes(1);
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(2);
    expect(mockStartPickupPipeline).toHaveBeenCalledTimes(2);
  });

  it("言語ペアを変えずに保存した場合は、パイプラインを再起動しない", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(mockStopPipeline).not.toHaveBeenCalled();
    expect(mockStartTranslationPipeline).toHaveBeenCalledTimes(1);
  });
});
