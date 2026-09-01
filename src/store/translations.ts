/**
 * 中央列「翻訳」の状態を保持するモジュールスコープのストアと、受信した発言を
 * 自動で翻訳ジョブに流し込むパイプライン。
 *
 * - 翻訳結果は発言 ID(`TwitchChatMessage.id`)をキーに保持し、ページ側は
 *   左列と同じ発言順で `entries[id]` を引いて描画する
 * - 翻訳は「自動で全件」を基本とし、`SessionPool` の低優先度キューに積む。
 *   流量が多く追いつかない分はキュー側で古いものから破棄され、`dropped`(未翻訳)として明示する
 * - Prompt API が使えない環境では暗黙のフォールバックをせず、診断結果の理由を
 *   `promptApi.reason` に保持して行ごとに「翻訳不可」を表示できるようにする
 * - モデルが未ダウンロードの環境では `LanguageModel.create()` にユーザー操作が必要なため、
 *   「接続する」クリックの延長で `warmUpTranslationPipeline` を呼び、ベースセッションを先に生成する
 *
 * `chat-connection.ts` と同様に、ページ遷移でホーム画面がアンマウントされても
 * 翻訳結果を失わないよう、React ツリーの外(Zustand ストア)に状態を置く。
 */
import { create } from "zustand";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { describeDiagnosis } from "@/lib/ai/describeDiagnosis";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { createSessionPool, LowPriorityQueueOverflowError, type SessionPool } from "@/lib/ai/session-pool";
import { createTranslateBaseSessionFactory, translateChatMessage } from "@/lib/ai/translate";
import { loadSettings, type Settings } from "@/lib/settings";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { subscribeToChatMessages, useChatConnectionStore } from "./chat-connection";

/** 発言1件ぶんの翻訳の状態 */
export type TranslationEntry =
  | { status: "pending" }
  | { status: "done"; translation: string }
  | { status: "failed"; reason: string }
  /** 低優先度キューの上限で破棄された(流量超過で未翻訳) */
  | { status: "dropped" }
  /** Prompt API が利用できない環境で受信した */
  | { status: "unavailable" };

/** Prompt API の利用可否(パイプライン開始時の環境診断結果) */
export type PromptApiStatus =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "unavailable"; reason: string };

interface TranslationState {
  promptApi: PromptApiStatus;
  /** 発言 ID → 翻訳の状態 */
  entries: Record<string, TranslationEntry>;
}

export const useTranslationStore = create<TranslationState>(() => ({
  promptApi: { status: "checking" },
  entries: {},
}));

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export interface TranslationPipelineDeps {
  diagnose: () => Promise<EnvironmentDiagnosis>;
  loadSettings: () => Settings;
  createPool: (settings: Settings) => SessionPool;
  subscribeToChatMessages: (listener: (message: TwitchChatMessage) => void) => () => void;
  /** 表示用リングバッファに現在残っている発言。ここから消えた発言の翻訳結果を破棄する */
  getMessages: () => TwitchChatMessage[];
}

/**
 * 環境診断が終わるまでに保留できる発言数の上限。低優先度キューの既定上限と同じ 20 とし、
 * 溢れた分は古いものから `dropped`(未翻訳)にする。
 */
export const MAX_WAITING_FOR_DIAGNOSIS = 20;

/** 現在動作中のパイプラインが公開する操作。`startTranslationPipeline` が設定し、停止時に外す */
interface ActivePipeline {
  warmUp: () => void;
}

let activePipeline: ActivePipeline | null = null;

const DEFAULT_DEPS: TranslationPipelineDeps = {
  diagnose: runBrowserDiagnosis,
  loadSettings: () => loadSettings().settings,
  createPool: (settings) =>
    createSessionPool({
      createBaseSession: createTranslateBaseSessionFactory(settings.targetLang, settings.explainLang),
    }),
  subscribeToChatMessages,
  getMessages: () => useChatConnectionStore.getState().messages,
};

function setEntry(id: string, entry: TranslationEntry): void {
  useTranslationStore.setState((prev) => ({ entries: { ...prev.entries, [id]: entry } }));
}

/** 表示用リングバッファに残っていない発言の翻訳結果を捨て、メモリが際限なく増えないようにする */
function pruneEntries(messages: TwitchChatMessage[]): void {
  const liveIds = new Set(messages.map((message) => message.id));
  useTranslationStore.setState((prev) => ({
    entries: Object.fromEntries(Object.entries(prev.entries).filter(([id]) => liveIds.has(id))),
  }));
}

/** 環境診断結果から、利用者に見せる「Prompt API が使えない理由」を取り出す */
function describePromptApiUnavailableReason(diagnosis: EnvironmentDiagnosis): string {
  const message = describeDiagnosis(diagnosis).find((item) => item.id === "language-model");
  return message?.message ?? "Prompt API を利用できません。";
}

/**
 * 翻訳パイプラインを開始する。戻り値の関数を呼ぶと発言の購読を解除し、
 * 待機中のジョブを中断する。ホーム画面のマウント時に1回呼び出す想定。
 */
export function startTranslationPipeline(deps: TranslationPipelineDeps = DEFAULT_DEPS): () => void {
  const controller = new AbortController();
  const settings = deps.loadSettings();
  let pool: SessionPool | null = null;
  /** 環境診断が終わるまでに受信した発言。診断結果に応じてまとめて処理する */
  let waitingForDiagnosis: TwitchChatMessage[] | null = [];
  /** 診断完了前にウォームアップを要求されたか */
  let warmUpRequested = false;

  useTranslationStore.setState({ promptApi: { status: "checking" } });

  function getPool(): SessionPool {
    pool ??= deps.createPool(settings);
    return pool;
  }

  function translate(message: TwitchChatMessage, id: string): void {
    setEntry(id, { status: "pending" });
    translateChatMessage(getPool(), message.text, { priority: "low", signal: controller.signal })
      .then((result) => setEntry(id, { status: "done", translation: result.translation }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof LowPriorityQueueOverflowError) {
          setEntry(id, { status: "dropped" });
          return;
        }
        setEntry(id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
      });
  }

  /** 診断待ちの保留に積む。上限を超えた分は古いものから `dropped` にする */
  function bufferUntilDiagnosed(message: TwitchChatMessage, id: string, buffer: TwitchChatMessage[]): void {
    buffer.push(message);
    setEntry(id, { status: "pending" });
    while (buffer.length > MAX_WAITING_FOR_DIAGNOSIS) {
      const dropped = buffer.shift();
      if (dropped?.id) setEntry(dropped.id, { status: "dropped" });
    }
  }

  function handleMessage(message: TwitchChatMessage): void {
    // 発言 ID が無いと翻訳結果を行に紐づけられないため投入しない(ページ側で「IDなし」と明示する)
    if (message.id === null) return;
    pruneEntries(deps.getMessages());

    if (waitingForDiagnosis) {
      bufferUntilDiagnosed(message, message.id, waitingForDiagnosis);
      return;
    }

    const promptApi = useTranslationStore.getState().promptApi;
    if (promptApi.status !== "ready") {
      setEntry(message.id, { status: "unavailable" });
      return;
    }

    translate(message, message.id);
  }

  /** ベースセッションを先に生成する。失敗した場合は Prompt API を利用不可として理由を保持する */
  function warmUp(): void {
    if (useTranslationStore.getState().promptApi.status !== "ready") return;
    getPool()
      .warmUp()
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        useTranslationStore.setState({
          promptApi: {
            status: "unavailable",
            reason: `Prompt API のセッションを生成できませんでした: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      });
  }

  /** 診断結果が確定したら、保留していた発言のうち表示中のものを投入するか「利用不可」として確定させる */
  function settleDiagnosis(promptApi: PromptApiStatus): void {
    const buffered = waitingForDiagnosis ?? [];
    waitingForDiagnosis = null;
    useTranslationStore.setState({ promptApi });
    if (warmUpRequested) warmUp();

    const liveIds = new Set(deps.getMessages().map((message) => message.id));
    buffered.forEach((message) => {
      if (message.id === null || !liveIds.has(message.id)) return;
      if (promptApi.status === "ready") {
        translate(message, message.id);
      } else {
        setEntry(message.id, { status: "unavailable" });
      }
    });
  }

  const unsubscribe = deps.subscribeToChatMessages(handleMessage);

  void deps
    .diagnose()
    .then((diagnosis) => {
      if (controller.signal.aborted) return;
      settleDiagnosis(
        diagnosis.overallReady
          ? { status: "ready" }
          : { status: "unavailable", reason: describePromptApiUnavailableReason(diagnosis) },
      );
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      settleDiagnosis({
        status: "unavailable",
        reason: `環境診断に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      });
    });

  const handle: ActivePipeline = {
    warmUp: () => {
      if (waitingForDiagnosis) {
        warmUpRequested = true;
        return;
      }
      warmUp();
    },
  };
  activePipeline = handle;

  return () => {
    unsubscribe();
    controller.abort();
    if (activePipeline === handle) activePipeline = null;
  };
}

/**
 * 翻訳用ベースセッションを先に生成する。「接続する」クリックなどユーザー操作の
 * ハンドラから呼ぶこと(モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要)。
 * パイプラインが開始されていない場合は何もしない。
 */
export function warmUpTranslationPipeline(): void {
  activePipeline?.warmUp();
}

/**
 * テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと。
 */
export function resetTranslationStoreForTests(): void {
  activePipeline = null;
  useTranslationStore.setState({ promptApi: { status: "checking" }, entries: {} });
}
