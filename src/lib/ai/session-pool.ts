/**
 * Gemini Nano(Prompt API)へのアクセスを、単一のベースセッション + 優先度付き直列キューで
 * 制御するモジュール。
 *
 * Prompt API は Web Worker で使えずメインスレッドで動作するため、無制御に
 * 呼び出すと UI がブロックされる。そのためここでは以下を保証する。
 *
 * - 同時実行数は常に1(直列処理)
 * - 優先度は2段階("high" = 利用者の明示的な操作, "low" = バックグラウンド生成)。
 *   高優先度ジョブは、待機中の低優先度ジョブより必ず先に処理される
 * - 低優先度キューには上限を設け、溢れた場合は最も古いものから破棄する
 *   (高優先度キューは利用者の明示的な操作なので上限を設けない)
 * - 各ジョブは `AbortSignal` を受け取れ、実行前に中断されていれば実行しない
 * - ベースセッションは `session.clone()` して使い捨てのブランチを都度作ることで、
 *   システムプロンプトのウォームアップ(初回生成コスト)を再利用しつつ、
 *   ジョブ間でコンテキストが汚染されないようにする
 */

/** Prompt API の `LanguageModel` セッションが最低限備えるべきインターフェース */
export interface PromptSessionLike {
  prompt(
    input: string,
    options?: { responseConstraint?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<string>;
  clone(): Promise<PromptSessionLike>;
  destroy(): void;
}

export type JobPriority = "high" | "low";

export interface SessionPoolDeps {
  /** ベースセッションを生成する。言語ペア(system prompt)は呼び出し側が組み立てて渡す */
  createBaseSession: () => Promise<PromptSessionLike>;
  /** 低優先度キューの最大長。超えた分は古いものから破棄する。省略時 20 */
  maxLowPriorityQueueLength?: number;
}

export interface SessionPool {
  /**
   * ジョブをキューに積み、完了(または拒否)した際に解決される Promise を返す。
   * `run` にはクローンされたセッションが渡され、実行後に自動で破棄される。
   */
  enqueue<T>(priority: JobPriority, run: (session: PromptSessionLike) => Promise<T>, signal?: AbortSignal): Promise<T>;
  /**
   * ジョブを積まずにベースセッションだけを生成する。
   * Prompt API はモデルが未ダウンロード(`downloadable`)のとき `LanguageModel.create()` に
   * ユーザー操作(user activation)を要求するため、クリックハンドラの延長で呼び出して
   * ベースセッションを先に作っておく用途に使う。生成に失敗した場合は例外をそのまま投げる。
   */
  warmUp(): Promise<void>;
}

const DEFAULT_MAX_LOW_PRIORITY_QUEUE_LENGTH = 20;

/**
 * 低優先度キューの上限超過で破棄されたジョブを拒否する際のエラー。
 * 呼び出し側が `instanceof` で判別し、「未翻訳(流量超過)」のような溢れ固有の表示に切り替えられるようにする。
 */
export class LowPriorityQueueOverflowError extends Error {
  constructor() {
    super("低優先度キューの上限に達したため、このジョブは破棄されました");
    this.name = "LowPriorityQueueOverflowError";
  }
}

interface QueuedJob {
  run: (session: PromptSessionLike) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** signal.reason があればそれを、無ければ標準的な AbortError を返す */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function createSessionPool(deps: SessionPoolDeps): SessionPool {
  const maxLowPriorityQueueLength = deps.maxLowPriorityQueueLength ?? DEFAULT_MAX_LOW_PRIORITY_QUEUE_LENGTH;

  const highQueue: QueuedJob[] = [];
  const lowQueue: QueuedJob[] = [];
  let baseSessionPromise: Promise<PromptSessionLike> | null = null;
  let isProcessing = false;

  function getBaseSession(): Promise<PromptSessionLike> {
    if (!baseSessionPromise) {
      baseSessionPromise = deps.createBaseSession().catch((error: unknown) => {
        // 生成に失敗したら次回 enqueue 時に再試行できるようキャッシュを捨てる
        baseSessionPromise = null;
        throw error;
      });
    }
    return baseSessionPromise;
  }

  function dropOldestLowPriorityJobIfOverCapacity() {
    while (lowQueue.length > maxLowPriorityQueueLength) {
      const dropped = lowQueue.shift();
      if (dropped?.onAbort) {
        dropped.signal?.removeEventListener("abort", dropped.onAbort);
      }
      dropped?.reject(new LowPriorityQueueOverflowError());
    }
  }

  function processNext() {
    if (isProcessing) return;
    const job = highQueue.shift() ?? lowQueue.shift();
    if (!job) return;
    if (job.onAbort) job.signal?.removeEventListener("abort", job.onAbort);

    if (job.signal?.aborted) {
      job.reject(abortReason(job.signal));
      processNext();
      return;
    }

    isProcessing = true;
    void (async () => {
      try {
        const baseSession = await getBaseSession();
        const jobSession = await baseSession.clone();
        try {
          const result = await job.run(jobSession);
          job.resolve(result);
        } finally {
          jobSession.destroy();
        }
      } catch (error) {
        job.reject(error);
      } finally {
        isProcessing = false;
        processNext();
      }
    })();
  }

  return {
    async warmUp() {
      await getBaseSession();
    },
    enqueue<T>(priority: JobPriority, run: (session: PromptSessionLike) => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }

        const job: QueuedJob = {
          run: run as (session: PromptSessionLike) => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
          signal,
        };

        if (signal) {
          job.onAbort = () => {
            const queue = priority === "high" ? highQueue : lowQueue;
            const index = queue.indexOf(job);
            if (index !== -1) {
              queue.splice(index, 1);
              job.reject(abortReason(signal));
            }
            // 既に実行開始済みの場合は run 側が signal を見て自ら中断する想定のため、ここでは何もしない
          };
          signal.addEventListener("abort", job.onAbort);
        }

        if (priority === "high") {
          highQueue.push(job);
        } else {
          lowQueue.push(job);
          dropOldestLowPriorityJobIfOverCapacity();
        }

        processNext();
      });
    },
  };
}
