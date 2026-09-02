/**
 * 受信した発言を自動で LLM ジョブに流し、結果を発言 ID ごとに保持する「自動パイプライン」の共通ファクトリ。
 * 翻訳列(`translations.ts`)と Pick up 列(`pickups.ts`)は「実行するジョブ」と「結果の形」だけが異なり、
 * それ以外の流れは同一のため、ここに 1 つだけ実装する(issue #24)。
 *
 * - 結果は発言 ID(`TwitchChatMessage.id`)をキーに保持し、ページ側は左列と同じ発言順で `entries[id]` を引いて描画する
 * - 発言ごとに Language Detector で言語を判定し(`detect-language.ts`)、学ぶ言語なら順方向
 *   (学ぶ言語→解説言語)のセッションプールへ、解説言語と同じなら逆方向(解説言語→学ぶ言語)の
 *   セッションプールへ投入し、どちらでもなければ `other-language` としてモデルを呼ばずに確定する。
 *   逆方向は「日本語の発言を英語に訳し、その英訳から Pick up する」ような学習機会を増やすための処理で、
 *   これにより日英混在チャットも学ぶ言語と解説言語の 1:1 ペアのままカバーできる
 * - ジョブは「自動で全件」を基本とし、`SessionPool` の低優先度キューに積む。
 *   流量が多く追いつかない分はキュー側で古いものから破棄され、`dropped` として明示する
 * - セッションプールは「パイプライン(用途ごとのシステムプロンプト)× 方向(順方向・逆方向)」ごとに持ち、必要になった時点で生成する。
 *   ジョブを流す直列キューはこのモジュールで 1 つだけ作り、全プールで共有する。Gemini Nano への `prompt()` が
 *   翻訳と Pick up で並走しないようにするため(issue #23)
 * - Prompt API / Language Detector の利用可否は `prompt-api.ts` の共有ストアに集約する。パイプラインは診断を 1 回だけ
 *   `ensurePromptApiDiagnosed` に依頼し、自分のセッションプールと Language Detector のウォームアップだけを担当する。
 *   使えない環境では暗黙のフォールバックをせず、行ごとに `unavailable` を保持する
 * - モデルが未ダウンロードの環境では `LanguageModel.create()` / `LanguageDetector.create()` にユーザー操作が必要なため、
 *   「接続する」クリックの延長で `warmUp` を呼び、ベースセッションと Language Detector を先に生成する
 * - `start` は前回の結果をすべて破棄し、表示用リングバッファに残っている発言を新しいパイプラインに再投入する。
 *   言語設定(`settings.ts` のストア)が変わったときにホーム画面がパイプラインを再起動し、
 *   古い設定の結果を残さず新しい設定で生成し直すため(issue #17)
 *
 * `chat-connection.ts` と同様に、ページ遷移でホーム画面がアンマウントされても結果を失わないよう、
 * React ツリーの外(Zustand ストア)に状態を置く。
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import {
  classifyDetectedLanguage,
  createBrowserLanguageDetector,
  type LanguageDetectorLike,
} from "@/lib/ai/detect-language";
import type { SupportedLanguage } from "@/lib/ai/prompts";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import {
  createPromptJobQueue,
  createSessionPool,
  LowPriorityQueueOverflowError,
  type PromptSessionLike,
  type SessionPool,
} from "@/lib/ai/session-pool";
import type { Settings } from "@/lib/settings";
import { extractPlainText } from "@/lib/twitch/emotes";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { subscribeToChatMessages, useChatConnectionStore } from "./chat-connection";
import { ensurePromptApiDiagnosed, markPromptApiUnavailable, usePromptApiStore, type PromptApiStatus } from "./prompt-api";
import { useSettingsStore } from "./settings";

/** 発言 1 件ぶんの処理状態。`TDone` は完了時に保持する結果の形(訳文・語句一覧など) */
export type PipelineEntry<TDone extends object> =
  | { status: "pending" }
  | ({ status: "done" } & TDone)
  | { status: "failed"; reason: string }
  /** 低優先度キューの上限で破棄された(流量超過で未処理) */
  | { status: "dropped" }
  /** Prompt API / Language Detector が利用できない環境で受信した */
  | { status: "unavailable" }
  /** 学ぶ言語にも解説言語にも該当しない言語(未判定 `und` を含む)の発言のため、翻訳・Pick up をしない */
  | { status: "other-language"; detectedLanguage: string };

export interface AutoPipelineState<TDone extends object> {
  /** 発言 ID → 処理状態 */
  entries: Record<string, PipelineEntry<TDone>>;
}

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export interface AutoPipelineDeps {
  diagnose: () => Promise<EnvironmentDiagnosis>;
  loadSettings: () => Settings;
  /** 順方向(学ぶ言語→解説言語)のセッションプールを生成する */
  createPool: (targetLang: SupportedLanguage, explainLang: SupportedLanguage) => SessionPool;
  /** 逆方向(解説言語→学ぶ言語)のセッションプールを生成する */
  createReversePool: (learningLang: SupportedLanguage, explainLang: SupportedLanguage) => SessionPool;
  /** 発言の言語判定に使う Language Detector を生成する */
  createDetector: () => Promise<LanguageDetectorLike>;
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
  /** 学ぶ言語と解説言語のペアから、順方向(学ぶ言語の発言用)のベースセッション生成関数を組み立てる */
  createBaseSession: (targetLang: SupportedLanguage, explainLang: SupportedLanguage) => () => Promise<PromptSessionLike>;
  /** 学ぶ言語と解説言語のペアから、逆方向(解説言語の発言用)のベースセッション生成関数を組み立てる */
  createReverseBaseSession: (
    learningLang: SupportedLanguage,
    explainLang: SupportedLanguage,
  ) => () => Promise<PromptSessionLike>;
  /**
   * LLM を呼ばずに結果を確定できる発言(emote だけの発言・チャットコマンドなど)はここで結果を返す。
   * `null` を返した発言だけを `runJob` / `runReverseJob` に渡す
   */
  resolveWithoutModel?: (message: TwitchChatMessage) => TDone | null;
  /** 学ぶ言語の発言 1 件を処理して結果を返す。低優先度キューの溢れは `LowPriorityQueueOverflowError` で通知される */
  runJob: (pool: SessionPool, message: TwitchChatMessage, context: AutoPipelineJobContext) => Promise<TDone>;
  /**
   * 解説言語の発言 1 件を逆方向(学ぶ言語への翻訳ベース)で処理して結果を返す。`pool` は逆方向のセッションプール。
   * 省略した場合は `runJob` を逆方向のセッションプールで実行する(翻訳のように順方向と処理が同一の用途向け)
   */
  runReverseJob?: (pool: SessionPool, message: TwitchChatMessage, context: AutoPipelineJobContext) => Promise<TDone>;
}

export interface AutoPipeline<TDone extends object> {
  useStore: UseBoundStore<StoreApi<AutoPipelineState<TDone>>>;
  /**
   * パイプラインを開始する。前回の結果をすべて破棄し、表示中の発言を再投入したうえで新しい発言の購読を始める。
   * 戻り値の関数を呼ぶと発言の購読を解除し、待機中のジョブを中断する。
   * ホーム画面のマウント時と、言語ペアの変更時に呼び出す想定(呼び出し前に前回の停止関数を呼ぶこと)
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

/**
 * 全パイプラインで共有する Prompt API の直列キュー(issue #23)。
 * 言語ペアに依存しないため、パイプラインを再起動してもこのキューは作り直さない
 */
const sharedPromptJobQueue = createPromptJobQueue();

export function createAutoPipeline<TDone extends object>(config: AutoPipelineConfig<TDone>): AutoPipeline<TDone> {
  const useStore = create<AutoPipelineState<TDone>>(() => ({ entries: {} }));

  let activePipeline: ActivePipeline | null = null;

  const defaultDeps: AutoPipelineDeps = {
    diagnose: runBrowserDiagnosis,
    loadSettings: () => {
      // 言語ペアは settings ストアが正本。未復元のまま起動すると LocalStorage の設定を無視してしまうため、
      // 暗黙にデフォルトへ倒さず呼び出し順の誤りとして失敗させる
      const { hydrated, settings } = useSettingsStore.getState();
      if (!hydrated) throw new Error("設定が未復元です。hydrateSettingsStore() を先に呼び出してください");
      return settings;
    },
    createPool: (targetLang, explainLang) =>
      createSessionPool({
        createBaseSession: config.createBaseSession(targetLang, explainLang),
        queue: sharedPromptJobQueue,
      }),
    createReversePool: (learningLang, explainLang) =>
      createSessionPool({
        createBaseSession: config.createReverseBaseSession(learningLang, explainLang),
        queue: sharedPromptJobQueue,
      }),
    createDetector: createBrowserLanguageDetector,
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
    /** 順方向(学ぶ言語→解説言語)のセッションプール。必要になった時点で生成する */
    let forwardPool: SessionPool | null = null;
    /** 逆方向(解説言語→学ぶ言語)のセッションプール。必要になった時点で生成する */
    let reversePool: SessionPool | null = null;
    /** Language Detector。生成に失敗したら次回に再試行できるようキャッシュを捨てる */
    let detectorPromise: Promise<LanguageDetectorLike> | null = null;
    /** 環境診断が終わるまでに受信した発言。診断結果に応じてまとめて処理する */
    let waitingForDiagnosis: TwitchChatMessage[] | null = [];
    /** 診断完了前にウォームアップを要求されたか */
    let warmUpRequested = false;

    function getForwardPool(): SessionPool {
      forwardPool ??= deps.createPool(settings.learningLang, settings.explainLang);
      return forwardPool;
    }

    function getReversePool(): SessionPool {
      reversePool ??= deps.createReversePool(settings.learningLang, settings.explainLang);
      return reversePool;
    }

    function getDetector(): Promise<LanguageDetectorLike> {
      if (!detectorPromise) {
        detectorPromise = deps.createDetector().catch((error: unknown) => {
          detectorPromise = null;
          throw error;
        });
      }
      return detectorPromise;
    }

    function setFailed(id: string, error: unknown): void {
      if (controller.signal.aborted) return;
      if (error instanceof LowPriorityQueueOverflowError) {
        setEntry(id, { status: "dropped" });
        return;
      }
      setEntry(id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
    }

    /** 学ぶ言語と判定した発言を、順方向のセッションプールで処理する */
    function runJob(message: TwitchChatMessage, id: string): Promise<void> {
      return config
        .runJob(getForwardPool(), message, { signal: controller.signal, getMessages: deps.getMessages })
        .then((result) => setEntry(id, { status: "done", ...result }));
    }

    /** 解説言語と判定した発言を、逆方向(解説言語→学ぶ言語)のセッションプールで処理する */
    function runReverseJob(message: TwitchChatMessage, id: string): Promise<void> {
      const run = config.runReverseJob ?? config.runJob;
      return run(getReversePool(), message, { signal: controller.signal, getMessages: deps.getMessages }).then(
        (result) => setEntry(id, { status: "done", ...result }),
      );
    }

    /** 発言の言語を判定し、学ぶ言語なら順方向・解説言語なら逆方向のジョブを投入、どちらでもなければモデルを呼ばずに確定する */
    async function detectAndRun(message: TwitchChatMessage, id: string): Promise<void> {
      const detector = await getDetector();
      const plainText = extractPlainText(message.text, message.emotes);
      const candidates = await detector.detect(plainText);
      if (controller.signal.aborted) return;
      const classification = classifyDetectedLanguage(plainText, candidates, settings);
      switch (classification.kind) {
        case "learning":
          await runJob(message, id);
          return;
        case "same-as-explanation":
          await runReverseJob(message, id);
          return;
        case "other":
          setEntry(id, { status: "other-language", detectedLanguage: classification.detectedLanguage });
          return;
      }
    }

    function process(message: TwitchChatMessage, id: string): void {
      const resolved = config.resolveWithoutModel?.(message) ?? null;
      if (resolved) {
        setEntry(id, { status: "done", ...resolved });
        return;
      }
      setEntry(id, { status: "pending" });
      detectAndRun(message, id).catch((error: unknown) => setFailed(id, error));
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

    /**
     * Language Detector と、順方向・逆方向それぞれのベースセッションを先に生成する。
     * 逆方向も接続直後から解説言語の発言(視聴者の母語のチャット)が流れてくるため同時に温める。
     * 失敗した場合は共有の Prompt API 状態を利用不可にして理由を保持する
     */
    function warmUp(): void {
      if (usePromptApiStore.getState().status.status !== "ready") return;
      const markFailed = (what: string) => (error: unknown) => {
        if (controller.signal.aborted) return;
        markPromptApiUnavailable(`Could not create ${what}: ${error instanceof Error ? error.message : String(error)}`);
      };
      getDetector().catch(markFailed("a Language Detector session"));
      getForwardPool().warmUp().catch(markFailed("a Prompt API session"));
      getReversePool().warmUp().catch(markFailed("a Prompt API session"));
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

    // 前回(別の言語ペアなど)の結果は残さず、表示中の発言を新しいパイプラインで処理し直す
    useStore.setState({ entries: {} });
    deps.getMessages().forEach(handleMessage);
    const unsubscribe = deps.subscribeToChatMessages(handleMessage);

    void ensurePromptApiDiagnosed(deps.diagnose, settings.llmProvider).then((promptApi) => {
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
