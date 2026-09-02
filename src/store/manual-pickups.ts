/**
 * ユーザーが生IRC列の範囲選択で手動Pick upした語句(messageId × term)と、
 * その意味生成の状態を保持する、モジュールスコープのストア(issue #72)。
 *
 * 自動抽出パイプライン(`pickups.ts`)のエントリ(`PickupDone.terms`)には混ぜず、
 * 別の状態として持ち、ホーム画面(`page.tsx`)が表示時にマージする。
 * 混ぜない理由: 言語設定変更・配信情報変化時にパイプラインが再起動し、自動抽出エントリは
 * 破棄・再生成されるため、混ぜると手動分も消えてしまう(hidden-pickups と同じ設計判断。issue #71)。
 *
 * - 意味の生成は `define-term.ts` に任せ、ユーザー操作起点のため high 優先度で実行する。
 *   セッションプールは手動Pick up専用に持ち、直列キューは自動パイプラインと共有する(issue #23)
 * - 生成中(pending)・失敗(failed)の状態も暗黙に隠さず保持し、表示側で明示する
 * - 語句の重複判定は正準形(trim + 小文字化。hidden-pickups と同じ基準)で行う
 * - 保持はセッション中のみ。チャンネル切り替え時は `chat-connection.ts` の connect() が
 *   `clearManualPickups()` で破棄する(前のチャンネルの発言IDは二度と参照されないため)
 */
import { create } from "zustand";
import { createDefineTermBaseSessionFactory, defineTerm } from "@/lib/ai/define-term";
import { createSessionPool, type SessionPool } from "@/lib/ai/session-pool";
import { sharedPromptJobQueue } from "./auto-pipeline";
import { usePromptApiStore, type PromptApiStatus } from "./prompt-api";
import { useSettingsStore } from "./settings";
import { getStreamInfo } from "./stream-info";

/** 手動Pick upした語句1件ぶんの状態 */
export type ManualPickupEntry =
  | { status: "pending"; term: string }
  | { status: "done"; term: string; meaning: string }
  | { status: "failed"; term: string; reason: string };

interface ManualPickupState {
  /** 発言IDごとの、手動Pick upした語句の一覧(追加順) */
  entries: Readonly<Record<string, readonly ManualPickupEntry[]>>;
}

export const useManualPickupStore = create<ManualPickupState>(() => ({ entries: {} }));

/** 手動Pick upが依存する外部処理。テストではフェイクを注入する */
export interface ManualPickupDeps {
  /** Prompt API の利用可否(prompt-api ストア)。ready 以外では生成を試みない */
  getPromptApiStatus: () => PromptApiStatus;
  /** 選択した語句と発言本文から、解説言語での意味を生成する */
  generateMeaning: (term: string, messageText: string) => Promise<string>;
}

/**
 * 手動Pick up専用のセッションプール。設定・配信の文脈が変わったら作り直すため、
 * 生成時のキーと一緒に保持する(自動パイプラインの「再起動でプールを作り直す」機構に相当)。
 */
let cachedPool: { key: string; pool: SessionPool } | null = null;

function getDefineTermPool(): SessionPool {
  const { hydrated, settings } = useSettingsStore.getState();
  // 手動Pick upはユーザー操作起点のため通常は復元済みだが、呼び出し順の誤りを暗黙に隠さない(Fail-Fast)
  if (!hydrated) throw new Error("設定が未復元です。hydrateSettingsStore() を先に呼び出してください");
  const streamInfo = getStreamInfo();
  const key = [
    settings.learningLang,
    settings.explainLang,
    settings.llmProvider,
    settings.openRouterApiKey,
    settings.openRouterModel,
    streamInfo?.title ?? "",
    streamInfo?.category ?? "",
    streamInfo?.broadcasterLogin ?? "",
    streamInfo?.broadcasterName ?? "",
  ].join("|");
  if (cachedPool === null || cachedPool.key !== key) {
    cachedPool = {
      key,
      pool: createSessionPool({
        createBaseSession: createDefineTermBaseSessionFactory(
          settings,
          settings.learningLang,
          settings.explainLang,
          streamInfo,
        ),
        queue: sharedPromptJobQueue,
      }),
    };
  }
  return cachedPool.pool;
}

const defaultDeps: ManualPickupDeps = {
  getPromptApiStatus: () => usePromptApiStore.getState().status,
  generateMeaning: async (term, messageText) => (await defineTerm(getDefineTermPool(), term, messageText)).meaning,
};

/** 語句の正準形。hidden-pickups / pickup-filter と同じ基準(trim + 小文字化)で重複を判定する */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** 指定した発言の手動Pick up一覧の末尾にエントリを追加する */
function appendEntry(messageId: string, entry: ManualPickupEntry): void {
  useManualPickupStore.setState((state) => ({
    entries: { ...state.entries, [messageId]: [...(state.entries[messageId] ?? []), entry] },
  }));
}

/**
 * 指定した発言の同じ語句のエントリを置き換える。
 * 生成完了までにクリア・削除されていた場合(チャンネル切替など)は反映しない
 */
function replaceEntry(messageId: string, term: string, entry: ManualPickupEntry): void {
  useManualPickupStore.setState((state) => {
    const current = state.entries[messageId];
    if (!current || !current.some((item) => item.term === term)) return state;
    return {
      entries: {
        ...state.entries,
        [messageId]: current.map((item) => (item.term === term ? entry : item)),
      },
    };
  });
}

/**
 * 範囲選択した語句を手動Pick upとして追加し、意味の生成を開始する。
 * - 空白のみの語句・同じ発言に正準形が同じ語句が既にある場合は何もしない
 * - Prompt API が利用できない環境では生成を試みず、理由付きの failed として保持する(暗黙に隠さない)
 * - 生成の成否はストアに反映するため、戻り値の Promise は失敗しても reject しない
 */
export async function addManualPickup(
  messageId: string,
  term: string,
  messageText: string,
  deps: ManualPickupDeps = defaultDeps,
): Promise<void> {
  const trimmed = term.trim();
  if (trimmed === "") return;
  const normalized = normalizeTerm(trimmed);
  const current = useManualPickupStore.getState().entries[messageId] ?? [];
  if (current.some((entry) => normalizeTerm(entry.term) === normalized)) return;

  const promptApi = deps.getPromptApiStatus();
  if (promptApi.status !== "ready") {
    const reason =
      promptApi.status === "unavailable" ? promptApi.reason : "The environment check has not finished yet";
    appendEntry(messageId, { status: "failed", term: trimmed, reason });
    return;
  }

  appendEntry(messageId, { status: "pending", term: trimmed });
  try {
    const meaning = await deps.generateMeaning(trimmed, messageText);
    replaceEntry(messageId, trimmed, { status: "done", term: trimmed, meaning });
  } catch (error) {
    replaceEntry(messageId, trimmed, {
      status: "failed",
      term: trimmed,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 指定した発言の手動Pick upから語句を削除する。最後の語句を削除した発言はエントリごと消す */
export function removeManualPickup(messageId: string, term: string): void {
  useManualPickupStore.setState((state) => {
    const current = state.entries[messageId];
    if (!current) return state;
    const kept = current.filter((entry) => entry.term !== term);
    if (kept.length === current.length) return state;
    const entries = { ...state.entries };
    if (kept.length === 0) {
      delete entries[messageId];
    } else {
      entries[messageId] = kept;
    }
    return { entries };
  });
}

/** 手動Pick upをすべて破棄する。チャンネル切り替え時(`chat-connection.ts` の connect())に呼ぶ */
export function clearManualPickups(): void {
  useManualPickupStore.setState({ entries: {} });
}

/** テスト専用: ストアとセッションプールのキャッシュを初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetManualPickupStoreForTests(): void {
  cachedPool = null;
  useManualPickupStore.setState({ entries: {} });
}
