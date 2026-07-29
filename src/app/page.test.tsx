/**
 * src/app/page.tsx(ライブチャット画面)のテスト。
 *
 * Phase 1 の主要導線である「チャンネル名を入力して接続する → 受信した発言が
 * 表示名・色・emote付きで表示される → 切断する」という流れに加え、
 * Phase 2 の主要導線である「発言をクリックするとAI解説が表示される」を検証する。
 * 実際のWebSocket通信・Prompt API呼び出しは行わず、`createTwitchIrcClient` /
 * `runBrowserDiagnosis` / `explainChatMessage` をモックしてシミュレートする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "./page";
import type { TwitchIrcClientCallbacks } from "@/lib/twitch/irc-client";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import type { ExplanationResult } from "@/lib/ai/schemas";
import { db } from "@/lib/db/schema";

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

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: vi.fn(),
}));

vi.mock("@/lib/ai/explain", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/explain")>("@/lib/ai/explain");
  return { ...actual, explainChatMessage: vi.fn() };
});

vi.mock("@/lib/ai/auto-extraction", () => ({
  createAutoExtractionPipeline: vi.fn(),
}));

import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { explainChatMessage } from "@/lib/ai/explain";
import { createAutoExtractionPipeline } from "@/lib/ai/auto-extraction";
import { saveSettings } from "@/lib/settings";

/** 全項目利用可能な基準診断結果 */
const readyDiagnosis: EnvironmentDiagnosis = {
  chromeVersion: 150,
  meetsMinimumChromeVersion: true,
  languageModel: { supported: true, availability: "available" },
  languageDetector: { supported: true, availability: "available" },
  storageEstimate: { quota: 100_000_000_000, usage: 1_000_000_000 },
  overallReady: true,
};

const notReadyDiagnosis: EnvironmentDiagnosis = {
  ...readyDiagnosis,
  languageModel: { supported: false, availability: null },
  overallReady: false,
};

/** サンプルの解説結果("gg chat" のような発言を想定) */
const sampleExplanation: ExplanationResult = {
  translation: "うまいプレイだったね、チャット",
  literal: "いいプレイ、チャット",
  items: [
    { term: "gg", kind: "abbreviation", meaning: "good game(お疲れ様/いい試合だった)の略語", note: "対戦後の定番の挨拶" },
  ],
  difficulty: 1,
};

beforeEach(async () => {
  vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
  // 自動抽出は既定でモック化し、明示的にテストしないケースでは何もしないダミーを返す
  vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage: vi.fn().mockResolvedValue(undefined) });
  // 前のテストの失敗等でカードが残っていても、各テストが空の状態から始まるようにする
  await db.cards.clear();
});

afterEach(async () => {
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  capturedCallbacks = null;
  vi.mocked(runBrowserDiagnosis).mockReset();
  vi.mocked(explainChatMessage).mockReset();
  vi.mocked(createAutoExtractionPipeline).mockReset();
  window.localStorage.clear();
  await db.cards.clear();
});

/** 接続 → open状態 → 指定メッセージを1件受信、までの共通セットアップ */
async function connectAndReceiveMessage(user: ReturnType<typeof userEvent.setup>, text = "gg chat") {
  await user.type(screen.getByLabelText("チャンネル名"), "somechannel");
  await user.click(screen.getByRole("button", { name: "接続する" }));
  capturedCallbacks?.onStateChange?.("open");
  capturedCallbacks?.onEvent({
    type: "privmsg",
    channel: "somechannel",
    message: {
      id: "msg-1",
      channel: "somechannel",
      userId: "987654",
      username: "codechamp92",
      displayName: "CodeChamp92",
      color: "#1E90FF",
      text,
      isAction: false,
      emotes: [],
      badges: [],
      timestampMs: 1690000000000,
    },
  });
  await screen.findByText(text);
}

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

describe("Home のAI解説(手動ピック)", () => {
  it("Prompt APIが利用可能な場合、発言をクリックすると解説が表示される", async () => {
    vi.mocked(explainChatMessage).mockResolvedValue(sampleExplanation);
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));

    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });
    expect(screen.getByText(sampleExplanation.literal)).toBeInTheDocument();
    expect(screen.getByText("gg")).toBeInTheDocument();
    expect(explainChatMessage).toHaveBeenCalledWith(
      expect.anything(),
      "gg chat",
      expect.objectContaining({ priority: "high", signal: expect.any(AbortSignal) }),
    );
  });

  it("解説内の語句の「カード化」ボタンを押すと単語帳カードとして保存され、ボタンが「保存済み」に変わる", async () => {
    vi.mocked(explainChatMessage).mockResolvedValue(sampleExplanation);
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "カード化" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "保存済み" })).toBeInTheDocument();
    });

    const stored = await db.cards.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      term: "gg",
      kind: "abbreviation",
      meaning: sampleExplanation.items[0].meaning,
      note: sampleExplanation.items[0].note,
      sourceMessageText: "gg chat",
      sourceChannel: "somechannel",
      sourceAuthor: "CodeChamp92",
      targetLang: "en",
      explainLang: "ja",
    });
  });

  it("解説生成中はローディング表示になる", async () => {
    let resolveExplain!: (value: ExplanationResult) => void;
    vi.mocked(explainChatMessage).mockImplementation(
      () => new Promise((resolve) => { resolveExplain = resolve; }),
    );
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));

    expect(await screen.findByText(/解説を生成中/)).toBeInTheDocument();

    resolveExplain(sampleExplanation);
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });
  });

  it("解説生成が失敗した場合はエラーメッセージを表示する", async () => {
    vi.mocked(explainChatMessage).mockRejectedValue(new Error("Prompt APIの応答が不正でした"));
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));

    await waitFor(() => {
      expect(screen.getByText("Prompt APIの応答が不正でした")).toBeInTheDocument();
    });
  });

  it("Prompt APIが利用できない場合はクリックしても解説を生成せず、理由を表示する", async () => {
    vi.mocked(runBrowserDiagnosis).mockResolvedValue(notReadyDiagnosis);
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));

    await waitFor(() => {
      expect(screen.getByText(/Prompt API/)).toBeInTheDocument();
    });
    expect(explainChatMessage).not.toHaveBeenCalled();
  });

  // ダイアログはモーダルのため、開いている間は背景の発言リストが inert(操作不可)になる。
  // そのため「別の発言を選び直す」導線は、実際には一度ダイアログを閉じてから行われる。
  // 閉じる操作(×ボタン/handleDialogOpenChange)が、進行中の解説ジョブを正しく中断することを検証する。
  it("ダイアログを閉じると進行中の解説ジョブを中断し、閉じた後は別の発言を選び直せる", async () => {
    let firstCallSignal: AbortSignal | undefined;
    vi.mocked(explainChatMessage).mockImplementationOnce((_pool, _text, options) => {
      firstCallSignal = options?.signal;
      return new Promise(() => {}); // 永久に未解決(中断だけを検証するため)
    });
    vi.mocked(explainChatMessage).mockResolvedValueOnce(sampleExplanation);
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "first message");
    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: {
        id: "msg-2",
        channel: "somechannel",
        userId: "222",
        username: "arukeinn",
        displayName: "arukeinn",
        color: null,
        text: "second message",
        isAction: false,
        emotes: [],
        badges: [],
        timestampMs: 1690000000001,
      },
    });
    await screen.findByText("second message");

    await user.click(screen.getByRole("button", { name: /first message/ }));
    expect(await screen.findByText(/解説を生成中/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(firstCallSignal?.aborted).toBe(true);

    await user.click(screen.getByRole("button", { name: /second message/ }));
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });
  });
});

describe("Home の自動抽出(バックグラウンド)", () => {
  it("自動抽出が無効(デフォルト設定)の場合、発言を受信してもパイプラインを呼ばない", async () => {
    const processMessage = vi.fn();
    vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage });
    const user = userEvent.setup();
    render(<Home />);

    await connectAndReceiveMessage(user, "that was such a clutch play honestly");

    expect(processMessage).not.toHaveBeenCalled();
  });

  it("自動抽出が有効な場合、受信した発言と設定をパイプラインに渡す", async () => {
    saveSettings({
      targetLang: "en",
      explainLang: "ja",
      autoExtraction: { enabled: true, strictness: "strict" },
    });
    const processMessage = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage });
    const user = userEvent.setup();
    render(<Home />);

    await connectAndReceiveMessage(user, "that was such a clutch play honestly");

    await waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(1);
    });
    expect(processMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: "that was such a clutch play honestly" }),
      expect.objectContaining({
        strictness: "strict",
        targetLang: "en",
        explainLang: "ja",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("Prompt APIが利用できない場合は、自動抽出が有効でもパイプラインを呼ばない", async () => {
    vi.mocked(runBrowserDiagnosis).mockResolvedValue(notReadyDiagnosis);
    saveSettings({
      targetLang: "en",
      explainLang: "ja",
      autoExtraction: { enabled: true, strictness: "normal" },
    });
    const processMessage = vi.fn();
    vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage });
    const user = userEvent.setup();
    render(<Home />);

    await connectAndReceiveMessage(user, "that was such a clutch play honestly");

    expect(processMessage).not.toHaveBeenCalled();
  });

  it("切断すると、自動抽出に渡したAbortSignalを中断する", async () => {
    saveSettings({
      targetLang: "en",
      explainLang: "ja",
      autoExtraction: { enabled: true, strictness: "normal" },
    });
    let capturedSignal: AbortSignal | undefined;
    const processMessage = vi.fn().mockImplementation((_message: unknown, options: { signal?: AbortSignal }) => {
      capturedSignal = options.signal;
      return new Promise(() => {}); // 中断だけを検証するため永久に未解決
    });
    vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage });
    const user = userEvent.setup();
    render(<Home />);

    await connectAndReceiveMessage(user, "that was such a clutch play honestly");
    await waitFor(() => {
      expect(capturedSignal).toBeDefined();
    });

    await user.click(await screen.findByRole("button", { name: "切断する" }));

    expect(capturedSignal?.aborted).toBe(true);
  });
});
