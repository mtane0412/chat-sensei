/**
 * 受信した発言を自動で LLM ジョブに流し、結果を発言 ID ごとに保持する「自動パイプライン」の共通ファクトリ。
 * 翻訳列(`translations.ts`)と Pick up 列(`pickups.ts`)は「実行するジョブ」と「結果の形」だけが異なり、
 * それ以外の流れは同一のため、ここに 1 つだけ実装する(issue #24)。
 *
 * - 結果は発言 ID(`TwitchChatMessage.id`)をキーに保持し、ページ側は左列と同じ発言順で `entries[id]` を引いて描画する
 * - ジョブは「自動で全件」を基本とし、`SessionPool` の低優先度キューに積む。
 *   流量が多く追いつかない分はキュー側で古いものから破棄され、`dropped` として明示する
 * - Prompt API の利用可否は `prompt-api.ts` の共有ストアに集約する。パイプラインは診断を 1 回だけ
 *   `ensurePromptApiDiagnosed` に依頼し、自分のセッションプールのウォームアップだけを担当する。
 *   使えない環境では暗黙のフォールバックをせず、行ごとに `unavailable` を保持する
 * - モデルが未ダウンロードの環境では `LanguageModel.create()` にユーザー操作が必要なため、
 *   「接続する」クリックの延長で `warmUp` を呼び、ベースセッションを先に生成する
 *
 * `chat-connection.ts` と同様に、ページ遷移でホーム画面がアンマウントされても結果を失わないよう、
 * React ツリーの外(Zustand ストア)に状態を置く。
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import {
  createSessionPool,
  LowPriorityQueueOverflowError,
  type PromptSessionLike,
  type SessionPool,
} from "@/lib/ai/session-pool";
import { loadSettings, type Settings } from "@/lib/settings";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { subscribeToChatMessages, useChatConnectionStore } from "./chat-connection";
import { ensurePromptApiDiagnosed, markPromptApiUnavailable, usePromptApiStore, type PromptApiStatus } from "./prompt-api";

/** 発言 1 件ぶんの処理状態。`TDone` は完了時に保持する結果の形(訳文・語句一覧など) */
export type PipelineEntry<TDone extends object> =
  | { status: "pending" }
  | ({ status: "done" } & TDone)
  | { status: "failed"; reason: string }
  /** 低優先度キューの上限で破棄された(流量超過で未処理) */
  | { status: "dropped" }
  /** Prompt API が利用できない環境で受信した */
  | { status: "unavailable" };

export interface AutoPipelineState<TDone extends object> {
  /** 発言 ID → 処理状態 */
  entries: Record<string, PipelineEntry<TDone>>;
}

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export interface AutoPipelineDeps {
  diagnose: () => Promise<EnvironmentDiagnosis>;
  loadSettings: () => Settings;
  createPool: (settings: Settings) => SessionPool;
  subscribeToChatMessages: (listener: (message: TwitchChatMessage) => void) => () => void;
  /** 表示用リングバッファに現在残っている発言。ここから消えた発言の結果を破棄する */
  getMessages: () => TwitchChatMessage[];
}

/** ジョブ関数に渡す実行時の文脈 */
export interface AutoPipelineJobContext {
  /** パイプライン停止時に中断される signal。`SessionPool.enqueue` に渡すこと */
  signal: AbortSignal;
  /** 表示用リングバッファに現在残っている発言 */
  getMessages: () => TwitchChatMessage[];
}

/** 翻訳・Pick up など用途ごとに異なる部分の定義 */
export interface AutoPipelineConfig<TDone extends object> {
  /** 設定の言語ペアから、この用途専用のベースセッション生成関数を組み立てる */
  createBaseSession: (settings: Settings) => () => Promise<PromptSessionLike>;
  /**
   * LLM を呼ばずに結果を確定できる発言(emote だけの発言・チャットコマンドなど)はここで結果を返す。
   * `null` を返した発言だけを `runJob` に渡す
   */
  resolveWithoutModel?: (message: TwitchChatMessage) => TDone | null;
  /** 発言 1 件を処理して結果を返す。低優先度キューの溢れは `LowPriorityQueueOverflowError` で通知される */
  runJob: (pool: SessionPool, message: TwitchChatMessage, context: AutoPipelineJobContext) => Promise<TDone>;
}

export interface AutoPipeline<TDone extends object> {
  useStore: UseBoundStore<StoreApi<AutoPipelineState<TDone>>>;
  /**
   * パイプラインを開始する。戻り値の関数を呼ぶと発言の購読を解除し、待機中のジョブを中断する。
   * ホーム画面のマウント時に 1 回呼び出す想定
   */
  start: (deps?: AutoPipelineDeps) => () => void;
  /**
   * ベースセッションを先に生成する。「接続する」クリックなどユーザー操作のハンドラから呼ぶこと
   * (モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要)。
   * パイプラインが開始されていない場合は何もしない
   */
  warmUp: () => void;
  /** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
  resetForTests: () => void;
}

/**
 * 環境診断が終わるまでに保留できる発言数の上限。低優先度キューの既定上限と同じ 20 とし、
 * 溢れた分は古いものから `dropped` にする。
 */
export const MAX_WAITING_FOR_DIAGNOSIS = 20;

/** 現在動作中のパイプラインが公開する操作。`start` が設定し、停止時に外す */
interface ActivePipeline {
  warmUp: () => void;
}

export function createAutoPipeline<TDone extends object>(config: AutoPipelineConfig<TDone>): AutoPipeline<TDone> {
  const useStore = create<AutoPipelineState<TDone>>(() => ({ entries: {} }));

  let activePipeline: ActivePipeline | null = null;

  const defaultDeps: AutoPipelineDeps = {
    diagnose: runBrowserDiagnosis,
    loadSettings: () => loadSettings().settings,
    createPool: (settings) => createSessionPool({ createBaseSession: config.createBaseSession(settings) }),
    subscribeToChatMessages,
    getMessages: () => useChatConnectionStore.getState().messages,
  };

  function setEntry(id: string, entry: PipelineEntry<TDone>): void {
    useStore.setState((prev) => ({ entries: { ...prev.entries, [id]: entry } }));
  }

  /** 表示用リングバッファに残っていない発言の結果を捨て、メモリが際限なく増えないようにする */
  function pruneEntries(messages: TwitchChatMessage[]): void {
    const liveIds = new Set(messages.map((message) => message.id));
    useStore.setState((prev) => {
      const kept = Object.entries(prev.entries).filter(([id]) => liveIds.has(id));
      // 破棄対象が無ければ同じ参照を返し、購読側(ページ)の不要な再レンダーを避ける
      if (kept.length === Object.keys(prev.entries).length) return prev;
      return { entries: Object.fromEntries(kept) };
    });
  }

  function start(deps: AutoPipelineDeps = defaultDeps): () => void {
    const controller = new AbortController();
    const settings = deps.loadSettings();
    let pool: SessionPool | null = null;
    /** 環境診断が終わるまでに受信した発言。診断結果に応じてまとめて処理する */
    let waitingForDiagnosis: TwitchChatMessage[] | null = [];
    /** 診断完了前にウォームアップを要求されたか */
    let warmUpRequested = false;

    function getPool(): SessionPool {
      pool ??= deps.createPool(settings);
      return pool;
    }

    function process(message: TwitchChatMessage, id: string): void {
      const resolved = config.resolveWithoutModel?.(message) ?? null;
      if (resolved) {
        setEntry(id, { status: "done", ...resolved });
        return;
      }
      setEntry(id, { status: "pending" });
      config
        .runJob(getPool(), message, { signal: controller.signal, getMessages: deps.getMessages })
        .then((result) => setEntry(id, { status: "done", ...result }))
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
      // 発言 ID が無いと結果を行に紐づけられないため投入しない(ページ側で「IDなし」と明示する)
      if (message.id === null) return;
      pruneEntries(deps.getMessages());

      if (waitingForDiagnosis) {
        bufferUntilDiagnosed(message, message.id, waitingForDiagnosis);
        return;
      }

      if (usePromptApiStore.getState().status.status !== "ready") {
        setEntry(message.id, { status: "unavailable" });
        return;
      }

      process(message, message.id);
    }

    /** ベースセッションを先に生成する。失敗した場合は共有の Prompt API 状態を利用不可にして理由を保持する */
    function warmUp(): void {
      if (usePromptApiStore.getState().status.status !== "ready") return;
      getPool()
        .warmUp()
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          markPromptApiUnavailable(
            `Prompt API のセッションを生成できませんでした: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
    }

    /** 診断結果が確定したら、保留していた発言のうち表示中のものを投入するか「利用不可」として確定させる */
    function settleDiagnosis(promptApi: PromptApiStatus): void {
      const buffered = waitingForDiagnosis ?? [];
      waitingForDiagnosis = null;
      if (warmUpRequested) warmUp();

      const liveIds = new Set(deps.getMessages().map((message) => message.id));
      buffered.forEach((message) => {
        if (message.id === null || !liveIds.has(message.id)) return;
        if (promptApi.status === "ready") {
          process(message, message.id);
        } else {
          setEntry(message.id, { status: "unavailable" });
        }
      });
    }

    const unsubscribe = deps.subscribeToChatMessages(handleMessage);

    void ensurePromptApiDiagnosed(deps.diagnose).then((promptApi) => {
      if (controller.signal.aborted) return;
      settleDiagnosis(promptApi);
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

  return {
    useStore,
    start,
    warmUp: () => activePipeline?.warmUp(),
    resetForTests: () => {
      activePipeline = null;
      useStore.setState({ entries: {} });
    },
  };
}
