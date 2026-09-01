/**
 * 右列「解説」の状態を保持するモジュールスコープのストアと、利用者の要求に応じて
 * 発言の解説を生成するパイプライン。
 *
 * - 翻訳列(translations.ts)と異なり、解説は全発言に対して生成せず、利用者が
 *   `requestExplanation` で明示的に要求した発言だけを `SessionPool` の高優先度ジョブとして積む
 * - 解説結果は発言 ID(`TwitchChatMessage.id`)をキーに保持し、ページ側は
 *   左列と同じ発言順で `entries[id]` を引いて描画する
 * - 生成中に別の発言を要求した場合、前のジョブは中断せず順に積む(FIFO)。
 *   同じ発言を生成中・完了済みに再要求しても二重には投入しない。失敗した発言は再要求で再試行する
 * - セッションプールは翻訳用とは別に持つ(`translate.ts` に記載の issue #15 方針 (a))。
 *   解説専用のシステムプロンプトを持つベースセッションを、最初の要求時に生成する。
 *   要求は必ずボタンクリック(ユーザー操作)の延長で行われるため、モデル未ダウンロード時に
 *   `LanguageModel.create()` が要求する user activation を満たし、翻訳列のようなウォームアップは不要
 * - Prompt API が使えない環境では暗黙のフォールバックをせず、診断結果の理由を
 *   `promptApi.reason` に保持して行ごとに「解説不可」を表示できるようにする
 *
 * `chat-connection.ts` と同様に、ページ遷移でホーム画面がアンマウントされても
 * 解説結果を失わないよう、React ツリーの外(Zustand ストア)に状態を置く。
 */
import { create } from "zustand";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { describeDiagnosis } from "@/lib/ai/describeDiagnosis";
import { createExplainBaseSessionFactory, explainChatMessage } from "@/lib/ai/explain";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import type { ExplanationResult } from "@/lib/ai/schemas";
import { createSessionPool, type SessionPool } from "@/lib/ai/session-pool";
import { loadSettings, type Settings } from "@/lib/settings";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { useChatConnectionStore } from "./chat-connection";
import type { PromptApiStatus } from "./translations";

/** 発言1件ぶんの解説の状態。要求されていない発言はエントリ自体を持たない */
export type ExplanationEntry =
  | { status: "pending" }
  | { status: "done"; result: ExplanationResult }
  | { status: "failed"; reason: string }
  /** Prompt API が利用できない(または診断未完了の)状態で要求された */
  | { status: "unavailable" };

interface ExplanationState {
  promptApi: PromptApiStatus;
  /** 発言 ID → 解説の状態 */
  entries: Record<string, ExplanationEntry>;
}

export const useExplanationStore = create<ExplanationState>(() => ({
  promptApi: { status: "checking" },
  entries: {},
}));

/** パイプラインが依存する外部処理。テストではすべてフェイクを注入する */
export interface ExplanationPipelineDeps {
  diagnose: () => Promise<EnvironmentDiagnosis>;
  loadSettings: () => Settings;
  createPool: (settings: Settings) => SessionPool;
  /** 表示用リングバッファに現在残っている発言。ここから消えた発言の解説結果を破棄する */
  getMessages: () => TwitchChatMessage[];
}

/** 現在動作中のパイプラインが公開する操作。`startExplanationPipeline` が設定し、停止時に外す */
interface ActivePipeline {
  request: (message: TwitchChatMessage) => void;
}

let activePipeline: ActivePipeline | null = null;

const DEFAULT_DEPS: ExplanationPipelineDeps = {
  diagnose: runBrowserDiagnosis,
  loadSettings: () => loadSettings().settings,
  createPool: (settings) =>
    createSessionPool({
      createBaseSession: createExplainBaseSessionFactory(settings.targetLang, settings.explainLang),
    }),
  getMessages: () => useChatConnectionStore.getState().messages,
};

function setEntry(id: string, entry: ExplanationEntry): void {
  useExplanationStore.setState((prev) => ({ entries: { ...prev.entries, [id]: entry } }));
}

function removeEntries(ids: Iterable<string>): void {
  const removing = new Set(ids);
  useExplanationStore.setState((prev) => ({
    entries: Object.fromEntries(Object.entries(prev.entries).filter(([id]) => !removing.has(id))),
  }));
}

/** 表示用リングバッファに残っていない発言の解説結果を捨て、メモリが際限なく増えないようにする */
function pruneEntries(messages: TwitchChatMessage[]): void {
  const liveIds = new Set(messages.map((message) => message.id));
  useExplanationStore.setState((prev) => ({
    entries: Object.fromEntries(Object.entries(prev.entries).filter(([id]) => liveIds.has(id))),
  }));
}

/** 環境診断結果から、利用者に見せる「Prompt API が使えない理由」を取り出す */
function describePromptApiUnavailableReason(diagnosis: EnvironmentDiagnosis): string {
  const message = describeDiagnosis(diagnosis).find((item) => item.id === "language-model");
  return message?.message ?? "Prompt API を利用できません。";
}

/**
 * 解説パイプラインを開始する。環境診断を行い Prompt API の利用可否を確定させる。
 * 戻り値の関数を呼ぶと以後の要求を受け付けなくなり、待機中のジョブを中断して
 * 生成中(pending)だったエントリを取り除く。
 * ホーム画面のマウント時に1回呼び出す想定。
 */
export function startExplanationPipeline(deps: ExplanationPipelineDeps = DEFAULT_DEPS): () => void {
  const controller = new AbortController();
  const settings = deps.loadSettings();
  let pool: SessionPool | null = null;
  /** このパイプラインが投入して未決着のジョブの発言 ID。停止時に pending のまま残さないよう取り除く */
  const pendingIds = new Set<string>();

  useExplanationStore.setState({ promptApi: { status: "checking" } });

  function getPool(): SessionPool {
    pool ??= deps.createPool(settings);
    return pool;
  }

  function explain(message: TwitchChatMessage, id: string): void {
    setEntry(id, { status: "pending" });
    pendingIds.add(id);
    explainChatMessage(getPool(), message.text, { priority: "high", signal: controller.signal })
      .then((result) => {
        // 停止後に決着したジョブの結果は、再開後のパイプラインの状態を上書きしないよう捨てる
        if (controller.signal.aborted) return;
        setEntry(id, { status: "done", result });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEntry(id, { status: "failed", reason: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => pendingIds.delete(id));
  }

  function request(message: TwitchChatMessage): void {
    // 発言 ID が無いと解説結果を行に紐づけられないため投入しない(ページ側で「IDなし」と明示する)
    if (message.id === null) return;
    pruneEntries(deps.getMessages());

    if (useExplanationStore.getState().promptApi.status !== "ready") {
      setEntry(message.id, { status: "unavailable" });
      return;
    }

    // 生成中・完了済みの発言は再投入しない(失敗した発言のみ再試行を許す)
    const current = useExplanationStore.getState().entries[message.id];
    if (current?.status === "pending" || current?.status === "done") return;

    explain(message, message.id);
  }

  void deps
    .diagnose()
    .then((diagnosis) => {
      if (controller.signal.aborted) return;
      useExplanationStore.setState({
        promptApi: diagnosis.overallReady
          ? { status: "ready" }
          : { status: "unavailable", reason: describePromptApiUnavailableReason(diagnosis) },
      });
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) return;
      useExplanationStore.setState({
        promptApi: {
          status: "unavailable",
          reason: `環境診断に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    });

  const handle: ActivePipeline = { request };
  activePipeline = handle;

  return () => {
    controller.abort();
    // 中断したジョブのエントリを pending のまま残さず取り除き、再開後に改めて要求できるようにする
    removeEntries(pendingIds);
    pendingIds.clear();
    if (activePipeline === handle) activePipeline = null;
  };
}

/**
 * 発言の解説を要求する。「解説」ボタンのクリックハンドラから呼ぶこと
 * (モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要)。
 * パイプラインが開始されていない場合は何もしない。
 */
export function requestExplanation(message: TwitchChatMessage): void {
  activePipeline?.request(message);
}

/**
 * テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと。
 */
export function resetExplanationStoreForTests(): void {
  activePipeline = null;
  useExplanationStore.setState({ promptApi: { status: "checking" }, entries: {} });
}
