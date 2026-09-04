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
import { createSessionPool, SessionPoolDisposedError, type SessionPool } from "@/lib/ai/session-pool";
import { sharedPromptJobQueue } from "./auto-pipeline";
import { normalizePickupTerm } from "./hidden-pickups";
import { recordPickupMeaningChecked } from "./pickup-encounters";
import { usePromptApiStore, type PromptApiStatus } from "./prompt-api";
import { useSettingsStore } from "./settings";
import { streamInfoPromptKey } from "@/lib/twitch/stream-info";
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
  /** 選択した語句と発言本文から、解説言語での意味を生成する。`signal` は削除・クリア時に中断される */
  generateMeaning: (term: string, messageText: string, signal?: AbortSignal) => Promise<string>;
}

/**
 * 手動Pick up専用のセッションプール。設定・配信の文脈が変わったら作り直すため、
 * 生成時のキーと一緒に保持する(自動パイプラインの「再起動でプールを作り直す」機構に相当)。
 */
let cachedPool: { key: string; pool: SessionPool } | null = null;

/**
 * キャッシュ中のプールを破棄して捨てる。「捨てる前に必ず dispose する」という不変条件を
 * 1箇所に集約し、旧プールのウォームアップ済みベースセッション(Gemini Nano のネイティブ
 * セッション)をリークさせない(issue #75)。プールが無ければ何もしない
 */
function disposeCachedPool(): void {
  cachedPool?.pool.dispose();
  cachedPool = null;
}

function getDefineTermPool(): SessionPool {
  const { hydrated, settings } = useSettingsStore.getState();
  // 手動Pick upはユーザー操作起点のため通常は復元済みだが、呼び出し順の誤りを暗黙に隠さない(Fail-Fast)。
  // このメッセージは失敗理由として画面に表示され得るため、UIの言語(英語)で書く
  if (!hydrated) throw new Error("Settings are not restored yet. Call hydrateSettingsStore() first");
  const streamInfo = getStreamInfo();
  // 設定はフィールドを手動列挙すると項目追加時に漏れやすいため構造ごと JSON にして比較する。
  // 配信情報はシステムプロンプトに焼き込むフィールドだけのキー(streamInfoPromptKey)を使い、
  // 定期リフレッシュ(issue #85)による視聴者数だけの変化でウォームアップ済みプールを作り直さない
  const key = JSON.stringify([settings, streamInfoPromptKey(streamInfo)]);
  if (cachedPool === null || cachedPool.key !== key) {
    // 旧プールに残っていたジョブは SessionPoolDisposedError で failed になり、
    // addManualPickup が再試行を促す理由に差し替える
    disposeCachedPool();
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
  generateMeaning: async (term, messageText, signal) => {
    const pool = getDefineTermPool();
    // モデル未ダウンロード時の LanguageModel.create() にはユーザー操作が必要なため、
    // クリックハンドラの延長にあたるこの時点でベースセッションの生成を開始しておく(auto-pipeline の warmUp と同じ理由)。
    // 生成失敗はここで握りつぶさず、直後の enqueue(defineTerm)が再試行して失敗理由を表面化させる
    void pool.warmUp().catch(() => {});
    return (await defineTerm(pool, term, messageText, { signal })).meaning;
  },
};

/**
 * 生成中(pending)ジョブの中断用 AbortController。キーは「発言ID + 語句」。
 * 削除・クリア時に中断することで、不要になった high 優先度ジョブが共有直列キューを占有し、
 * 次のチャンネルの翻訳・Pick up(low 優先度)を遅らせないようにする(レビュー C3)
 */
const pendingControllers = new Map<string, AbortController>();

function pendingKey(messageId: string, term: string): string {
  return `${messageId}\u0000${term}`;
}

/** 指定した発言・語句の生成ジョブを中断する。生成中でなければ何もしない */
function abortPendingGeneration(messageId: string, term: string): void {
  const controller = pendingControllers.get(pendingKey(messageId, term));
  if (!controller) return;
  pendingControllers.delete(pendingKey(messageId, term));
  controller.abort();
}

/** すべての生成ジョブを中断する。クリア・テストリセット時に呼ぶ */
function abortAllPendingGenerations(): void {
  const controllers = [...pendingControllers.values()];
  pendingControllers.clear();
  controllers.forEach((controller) => controller.abort());
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
  const normalized = normalizePickupTerm(trimmed);
  const current = useManualPickupStore.getState().entries[messageId] ?? [];
  const existing = current.find((entry) => normalizePickupTerm(entry.term) === normalized);
  // pending(生成中)・done(生成済み)は重複として何もしない。failed だけは再選択を再試行として扱い、
  // 古い failed エントリを取り除いてから生成をやり直す(レビュー C1。診断完了後の再試行もこの経路で可能になる)
  if (existing && existing.status !== "failed") return;
  if (existing) removeManualPickup(messageId, existing.term);

  const promptApi = deps.getPromptApiStatus();
  if (promptApi.status !== "ready") {
    const reason =
      promptApi.status === "unavailable" ? promptApi.reason : "The environment check has not finished yet";
    appendEntry(messageId, { status: "failed", term: trimmed, reason });
    return;
  }

  const controller = new AbortController();
  pendingControllers.set(pendingKey(messageId, trimmed), controller);
  appendEntry(messageId, { status: "pending", term: trimmed });
  try {
    const meaning = await deps.generateMeaning(trimmed, messageText, controller.signal);
    replaceEntry(messageId, trimmed, { status: "done", term: trimmed, meaning });
    // 意味の生成が完了した = ユーザーが意味を確認した、としてユーザー辞書に記録する(issue #110)。
    // 失敗・中断時は意味を確認できていないため記録しない
    recordPickupMeaningChecked(trimmed);
  } catch (error) {
    // 削除・クリアによる中断はエントリ自体が消えているため、replaceEntry のガードで何も反映されない。
    // プール差し替え(設定変更・配信情報の更新)で破棄されたジョブは、内部文言ではなく
    // 再試行(語句の再選択)を促す理由に差し替える(issue #75)
    const reason =
      error instanceof SessionPoolDisposedError
        ? "Cancelled because the settings or stream context changed. Select the term again to retry."
        : error instanceof Error
          ? error.message
          : String(error);
    replaceEntry(messageId, trimmed, { status: "failed", term: trimmed, reason });
  } finally {
    pendingControllers.delete(pendingKey(messageId, trimmed));
  }
}

/**
 * 指定した発言の手動Pick upから語句を削除する。最後の語句を削除した発言はエントリごと消す。
 * 生成中(pending)の語句は生成ジョブも中断する(レビュー C3)
 */
export function removeManualPickup(messageId: string, term: string): void {
  abortPendingGeneration(messageId, term);
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
  abortAllPendingGenerations();
  // チャンネル切替後は配信情報が変わりプールキーが二度と一致しないため、ここで破棄しないと
  // 旧チャンネルのベースセッションがページの寿命までリークし得る(issue #75)
  disposeCachedPool();
  useManualPickupStore.setState({ entries: {} });
}

/** テスト専用: ストアとセッションプールのキャッシュを初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetManualPickupStoreForTests(): void {
  abortAllPendingGenerations();
  disposeCachedPool();
  useManualPickupStore.setState({ entries: {} });
}
