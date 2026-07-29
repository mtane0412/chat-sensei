/**
 * src/app/page.tsx(ライブチャット画面)のテスト。
 *
 * Phase 1 の主要導線である「チャンネル名を入力して接続する → 受信した発言が
 * 表示名・色・emote付きで表示される → 切断する」という流れに加え、
 * Phase 2 の主要導線である「発言をクリックするとAI解説が表示される」、
 * Phase 5 の主要導線である「自動抽出候補がチャット横のパネルにリアルタイムで
 * 蓄積され、採用/却下できる」を検証する。
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
import { createCandidate } from "@/lib/db/candidates";

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
  // 実装(irc-client.ts)と同じ正規化ロジックをテストでも使う(チャンネル名の小文字化・#除去)
  normalizeChannelName: (channel: string) => channel.replace(/^#/, "").toLowerCase(),
}));

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: vi.fn(),
}));

vi.mock("@/lib/ai/explain", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/explain")>("@/lib/ai/explain");
  return {
    ...actual,
    explainChatMessage: vi.fn(),
    // 言語ペアがセッションプール生成に正しく渡っているかを検証するため、実装は維持しつつ呼び出しを監視する
    createExplainBaseSessionFactory: vi.fn(actual.createExplainBaseSessionFactory),
  };
});

vi.mock("@/lib/ai/auto-extraction", () => ({
  createAutoExtractionPipeline: vi.fn(),
}));

import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { explainChatMessage, createExplainBaseSessionFactory } from "@/lib/ai/explain";
import { createAutoExtractionPipeline } from "@/lib/ai/auto-extraction";
import { saveSettings } from "@/lib/settings";
import { resetChatConnectionStoreForTests } from "@/store/chat-connection";

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
  await db.candidates.clear();
  // チャット接続ストアはページ遷移をまたいで状態を保持するモジュールスコープの
  // シングルトンであり、テスト間でも共有されてしまうため、毎回未接続状態に戻す
  resetChatConnectionStoreForTests();
});

afterEach(async () => {
  mockConnect.mockClear();
  mockDisconnect.mockClear();
  capturedCallbacks = null;
  vi.mocked(runBrowserDiagnosis).mockReset();
  vi.mocked(explainChatMessage).mockReset();
  vi.mocked(createExplainBaseSessionFactory).mockClear();
  vi.mocked(createAutoExtractionPipeline).mockReset();
  window.localStorage.clear();
  await db.cards.clear();
  await db.candidates.clear();
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

describe("Home の配信embed(Twitch埋め込みプレイヤー)", () => {
  it("未接続の状態では配信embedを表示しない", () => {
    render(<Home />);

    expect(screen.queryByTitle(/Twitch配信プレイヤー/)).not.toBeInTheDocument();
  });

  it("チャンネル名を入力して接続すると、そのチャンネルの配信embedが表示される", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByLabelText("チャンネル名"), "ZackRawrr");
    await user.click(screen.getByRole("button", { name: "接続する" }));
    capturedCallbacks?.onStateChange?.("open");

    const iframe = await screen.findByTitle("Twitch配信プレイヤー: zackrawrr");
    expect(iframe.tagName).toBe("IFRAME");
  });

  it("切断すると、配信embedが非表示になる", async () => {
    const user = userEvent.setup();
    render(<Home />);

    await user.type(screen.getByLabelText("チャンネル名"), "somechannel");
    await user.click(screen.getByRole("button", { name: "接続する" }));
    capturedCallbacks?.onStateChange?.("open");
    await screen.findByTitle("Twitch配信プレイヤー: somechannel");

    await user.click(screen.getByRole("button", { name: "切断する" }));

    expect(screen.queryByTitle(/Twitch配信プレイヤー/)).not.toBeInTheDocument();
  });

  // 本来の不具合: 発言クリックで開く解説パネルが中央モーダル(modal既定=true)実装だったため、
  // base-ui Dialogがパネル外の要素すべてに inert/aria-hidden="true" を付与し、
  // その配下にある配信embedのiframeがブラウザからバックグラウンドタブ相当に扱われ再生が止まっていた。
  // 解説パネルを非モーダル化した後は、開いていても配信embedがinert化されず再生が止まらないことを検証する。
  it("発言をクリックして解説パネルを開いても、配信embedのiframeはinert化されない(再生が止まらない)", async () => {
    vi.mocked(explainChatMessage).mockResolvedValue(sampleExplanation);
    const user = userEvent.setup();
    render(<Home />);
    await connectAndReceiveMessage(user, "gg chat");
    const iframe = await screen.findByTitle("Twitch配信プレイヤー: somechannel");

    await user.click(screen.getByRole("button", { name: /gg chat/ }));
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });

    expect(iframe).not.toHaveAttribute("inert");
    expect(iframe.closest("[inert]")).toBeNull();
    expect(iframe.closest('[aria-hidden="true"]')).toBeNull();
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

  // 閉じる操作(×ボタン/handleDialogOpenChange)が、進行中の解説ジョブを正しく中断することを検証する。
  it("パネルを閉じると進行中の解説ジョブを中断し、閉じた後は別の発言を選び直せる", async () => {
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

  // 解説パネルは非モーダル(サイド展開)のため、開いたまま背景の発言リストを操作できる。
  // パネルを閉じずに別の発言をクリックした場合も、進行中のジョブを中断して新しい発言の解説に切り替わることを検証する。
  it("パネルを閉じずに別の発言をクリックすると、進行中の解説ジョブを中断して新しい発言の解説に切り替わる", async () => {
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

    // パネルを閉じずに、そのまま別の発言をクリックする
    await user.click(screen.getByRole("button", { name: /second message/ }));

    expect(firstCallSignal?.aborted).toBe(true);
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

describe("Home の自動抽出候補パネル", () => {
  /** テスト用の候補データ(意味の分かる日本語文字列を使用) */
  function buildCandidateInput(overrides: Partial<Parameters<typeof createCandidate>[0]> = {}) {
    return {
      term: "clutch",
      kind: "word" as const,
      meaning: "土壇場での見事なプレー",
      note: "対戦ゲームの実況・チャットでよく使われる",
      sourceMessageText: "that was such a clutch play honestly",
      sourceChannel: "somechannel",
      sourceAuthor: "yamada_taro",
      targetLang: "en" as const,
      explainLang: "ja" as const,
      tags: [],
      ...overrides,
    };
  }

  it("候補がない場合はチャット横のパネルを表示しない", () => {
    render(<Home />);

    expect(screen.queryByText("自動抽出候補")).not.toBeInTheDocument();
  });

  it("候補が生成されると、チャット横のパネルにリアルタイムで表示される", async () => {
    render(<Home />);

    await createCandidate(buildCandidateInput());

    expect(await screen.findByText("自動抽出候補")).toBeInTheDocument();
    expect(screen.getByText("clutch")).toBeInTheDocument();
    expect(screen.getByText("土壇場での見事なプレー")).toBeInTheDocument();
  });

  it("採用ボタンを押すと候補が単語帳に保存され、パネルから消える", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await createCandidate(buildCandidateInput({ term: "GG", meaning: "good game(お疲れ様)の略語" }));
    await screen.findByText("GG");

    await user.click(screen.getByRole("button", { name: "採用" }));

    await waitFor(() => {
      expect(screen.queryByText("自動抽出候補")).not.toBeInTheDocument();
    });
    const storedCards = await db.cards.toArray();
    expect(storedCards).toHaveLength(1);
    expect(storedCards[0].term).toBe("GG");
    expect(await db.candidates.count()).toBe(0);
  });

  it("却下ボタンを押すと候補が削除され、パネルから消える(単語帳には保存されない)", async () => {
    const user = userEvent.setup();
    render(<Home />);
    await createCandidate(buildCandidateInput());
    await screen.findByText("clutch");

    await user.click(screen.getByRole("button", { name: "却下" }));

    await waitFor(() => {
      expect(screen.queryByText("自動抽出候補")).not.toBeInTheDocument();
    });
    const storedCards = await db.cards.toArray();
    expect(storedCards).toHaveLength(0);
    expect(await db.candidates.count()).toBe(0);
  });
});

describe("Home の言語ペア切替(通し確認)", () => {
  // チャット接続(TwitchIrcClient)・接続状態・発言一覧は store/chat-connection.ts
  // でページ遷移をまたいで維持される一方、AI解説用のセッションプールは Home
  // コンポーネントのローカルなref(sessionPoolRef)で画面ごとに1度だけ生成される。
  // /settings で言語ペアを変更して / に戻ってきた場合、チャット接続自体は
  // 再接続せずに維持されたまま、新しいセッションプールが最新の言語ペアで
  // 作り直されることを検証する(「アンマウント→設定変更→再マウント」で
  // 画面遷移を再現する)。
  it("言語ペアを変更して画面を行き来しても、チャット接続は維持されたまま新しい設定でベースセッションが作り直される", async () => {
    saveSettings({
      targetLang: "en",
      explainLang: "ja",
      autoExtraction: { enabled: false, strictness: "normal" },
    });
    vi.mocked(explainChatMessage).mockResolvedValue(sampleExplanation);

    const user1 = userEvent.setup();
    const { unmount } = render(<Home />);
    await connectAndReceiveMessage(user1, "gg chat");
    await user1.click(screen.getByRole("button", { name: /gg chat/ }));
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });

    expect(createExplainBaseSessionFactory).toHaveBeenCalledTimes(1);
    expect(createExplainBaseSessionFactory).toHaveBeenNthCalledWith(1, "en", "ja");

    // /settings で言語ペアを変更し、/ に戻ってきた状況を再現する(コンポーネントの破棄・再生成)
    unmount();
    saveSettings({
      targetLang: "es",
      explainLang: "de",
      autoExtraction: { enabled: false, strictness: "normal" },
    });

    const user2 = userEvent.setup();
    render(<Home />);

    // 再接続操作をしていないにもかかわらず、接続済みの状態と直前までの発言が維持されている
    // (= ページ遷移でチャット接続が切れないことの検証)
    expect(await screen.findByText("接続済み")).toBeInTheDocument();
    expect(screen.getByText("gg chat")).toBeInTheDocument();

    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: {
        id: "msg-otra",
        channel: "somechannel",
        userId: "333333",
        username: "viajeroanon",
        displayName: "viajeroanon",
        color: null,
        text: "otra vez chat",
        isAction: false,
        emotes: [],
        badges: [],
        timestampMs: 1690000000002,
      },
    });
    await screen.findByText("otra vez chat");

    await user2.click(screen.getByRole("button", { name: /otra vez chat/ }));
    await waitFor(() => {
      expect(screen.getByText(sampleExplanation.translation)).toBeInTheDocument();
    });

    expect(createExplainBaseSessionFactory).toHaveBeenCalledTimes(2);
    expect(createExplainBaseSessionFactory).toHaveBeenNthCalledWith(2, "es", "de");
  });
});

describe("Home のページ遷移(チャット接続の永続化)", () => {
  // 本来の不具合: チャットに接続した後、単語帳(/deck)・復習(/study)・設定(/settings)
  // ページに遷移すると、Home がアンマウントされることでチャット接続そのものが
  // 切れてしまっていた。store/chat-connection.ts に接続状態・発言一覧を移したことで、
  // Home がアンマウント・再マウントされても接続と発言が保持されることを検証する。
  it("接続後にページ遷移(アンマウント)しても、再度チャンネル名を入力せずに接続状態と発言一覧が保持される", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Home />);
    await connectAndReceiveMessage(user, "nice play chat");
    expect(screen.getByText("接続済み")).toBeInTheDocument();

    // /deck・/study・/settings への遷移を、Home のアンマウントとして再現する
    unmount();
    render(<Home />);

    expect(screen.getByText("接続済み")).toBeInTheDocument();
    expect(screen.getByText("nice play chat")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切断する" })).toBeInTheDocument();
  });

  // 自動抽出(自動抽出パイプラインへの投入)は Home コンポーネントの購読(subscribeToChatMessages)に
  // 依存しており、チャット接続そのものとは独立している。画面遷移中(Home アンマウント中)は
  // 購読が解除されるため発言は自動抽出されず、再マウント後に届いた発言だけが自動抽出されることを検証する。
  it("画面遷移中(アンマウント中)に届いた発言は自動抽出されず、再マウント後に届いた発言のみ自動抽出される", async () => {
    saveSettings({
      targetLang: "en",
      explainLang: "ja",
      autoExtraction: { enabled: true, strictness: "normal" },
    });
    const processMessage = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createAutoExtractionPipeline).mockReturnValue({ processMessage });
    const user = userEvent.setup();

    const { unmount } = render(<Home />);
    await connectAndReceiveMessage(user, "first message before leaving");
    await waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(1);
    });

    // /deck 等への遷移を、Home のアンマウントとして再現する。
    // 接続(store側)は維持されたまま、Home 側の自動抽出の購読だけが解除される。
    unmount();
    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: {
        id: "msg-while-away",
        channel: "somechannel",
        userId: "444444",
        username: "awaymessage",
        displayName: "awaymessage",
        color: null,
        text: "message while away",
        isAction: false,
        emotes: [],
        badges: [],
        timestampMs: 1690000000003,
      },
    });

    render(<Home />);
    // 再マウント直後は、環境診断(runBrowserDiagnosis)の非同期解決を待つ必要がある
    // (診断結果はrefへの反映も含めて非同期に完了するため、ここで一度イベントループを譲る)
    await new Promise((resolve) => setTimeout(resolve, 0));
    // 遷移前の発言・アンマウント中に届いた発言のいずれも画面には残っている(接続自体は維持されている)
    await screen.findByText("message while away");
    expect(screen.getByText("first message before leaving")).toBeInTheDocument();
    // しかしアンマウント中に届いた発言は自動抽出されない(呼び出し回数は1のまま)
    expect(processMessage).toHaveBeenCalledTimes(1);

    // 再マウント後に届いた発言は、通常どおり自動抽出される
    capturedCallbacks?.onEvent({
      type: "privmsg",
      channel: "somechannel",
      message: {
        id: "msg-after-return",
        channel: "somechannel",
        userId: "555555",
        username: "returnmessage",
        displayName: "returnmessage",
        color: null,
        text: "message after return",
        isAction: false,
        emotes: [],
        badges: [],
        timestampMs: 1690000000004,
      },
    });

    await waitFor(() => {
      expect(processMessage).toHaveBeenCalledTimes(2);
    });
    expect(processMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ text: "message after return" }),
      expect.anything(),
    );
  });
});
