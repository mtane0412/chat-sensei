/**
 * Gemini Nano(Prompt API)へのアクセスを、用途ごとのベースセッション + アプリ全体で 1 つの
 * 優先度付き直列キューで制御するモジュール。
 *
 * Prompt API は Web Worker で使えずメインスレッドで動作するため、無制御に
 * 呼び出すと UI がブロックされる。そのためここでは以下を保証する。
 *
 * - 同時実行数は常に1(直列処理)。翻訳用・Pick up 用のようにシステムプロンプト(ベースセッション)が
 *   異なるプールでも、同じ `PromptJobQueue` を共有すればアプリ全体で 1 つずつしか `prompt()` を投げない(issue #23)
 * - 優先度は2段階("high" = 利用者の明示的な操作, "low" = バックグラウンド生成)。
 *   高優先度ジョブは、待機中の低優先度ジョブより必ず先に処理される
 * - 低優先度キューには上限を設け、溢れた場合はプールを問わず最も古いものから破棄する
 *   (高優先度キューは利用者の明示的な操作なので上限を設けない)
 * - 各ジョブは `AbortSignal` を受け取れ、実行前に中断されていれば実行しない
 * - ベースセッションは `session.clone()` して使い捨てのブランチを都度作ることで、
 *   システムプロンプトのウォームアップ(初回生成コスト)を再利用しつつ、
 *   ジョブ間でコンテキストが汚染されないようにする
 *
 * 役割分担:
 * - `createPromptJobQueue`: 優先度・上限・中断を扱う直列キュー。ベースセッションのことは知らない
 * - `createSessionPool`: ベースセッション 1 つを保持し、ジョブをクローンセッション付きでキューに積む
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

export interface PromptJobQueueOptions {
  /** 低優先度キューの最大長。超えた分は古いものから破棄する。省略時 20 */
  maxLowPriorityQueueLength?: number;
}

/**
 * Prompt API 呼び出しの直列キュー。複数の `SessionPool` で 1 つを共有し、
 * アプリ全体の同時実行数を 1 に保つ。
 */
export interface PromptJobQueue {
  /**
   * ジョブをキューに積み、完了(または拒否)した際に解決される Promise を返す。
   * `run` は前のジョブが完了してから呼び出される。
   */
  enqueue<T>(priority: JobPriority, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export interface SessionPoolDeps {
  /** ベースセッションを生成する。言語ペア(system prompt)は呼び出し側が組み立てて渡す */
  createBaseSession: () => Promise<PromptSessionLike>;
  /** ジョブを積む直列キュー。用途の異なるプール間で同じものを渡し、並走を防ぐ */
  queue: PromptJobQueue;
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
  /**
   * 生成済み(生成中を含む)のベースセッションを `destroy()` し、Gemini Nano のネイティブセッションを
   * 解放する。プールの差し替え・パイプラインの停止時に呼ぶこと(issue #75)。
   * - 冪等であり、2回以上呼んでも安全
   * - 呼び出し後の `enqueue` / `warmUp` はベースセッションを再生成せず
   *   `SessionPoolDisposedError` で拒否する(Fail-Fast)
   * - 実行中のジョブは影響を受けない。クローン中(`clone()` 実行中)の場合は
   *   クローン完了を待ってからベースセッションを destroy する
   */
  dispose(): void;
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

/**
 * dispose() 済みのプールに enqueue / warmUp した際のエラー。
 * 呼び出し側(manual-pickups など)が `instanceof` で判別し、
 * 内部文言ではなく利用者向けの失敗理由に差し替えられるようにする(issue #75)。
 */
export class SessionPoolDisposedError extends Error {
  constructor() {
    // failed の理由として画面に表示され得るため、UIの言語(英語)で書く
    super("This session pool has already been disposed");
    this.name = "SessionPoolDisposedError";
  }
}

interface QueuedJob {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** signal.reason があればそれを、無ければ標準的な AbortError を返す */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function createPromptJobQueue(options: PromptJobQueueOptions = {}): PromptJobQueue {
  const maxLowPriorityQueueLength = options.maxLowPriorityQueueLength ?? DEFAULT_MAX_LOW_PRIORITY_QUEUE_LENGTH;
  // 負数・小数・NaN・Infinity は溢れ判定(`lowQueue.length > 上限`)の意味が壊れるため、暗黙に丸めず生成時点で失敗させる
  if (!Number.isInteger(maxLowPriorityQueueLength) || maxLowPriorityQueueLength < 0) {
    throw new Error(`maxLowPriorityQueueLength は 0 以上の整数である必要があります: ${maxLowPriorityQueueLength}`);
  }

  const highQueue: QueuedJob[] = [];
  const lowQueue: QueuedJob[] = [];
  let isProcessing = false;

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
        job.resolve(await job.run());
      } catch (error) {
        job.reject(error);
      } finally {
        isProcessing = false;
        processNext();
      }
    })();
  }

  return {
    enqueue<T>(priority: JobPriority, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(abortReason(signal));
          return;
        }

        const job: QueuedJob = {
          run,
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

export function createSessionPool(deps: SessionPoolDeps): SessionPool {
  let baseSessionPromise: Promise<PromptSessionLike> | null = null;
  /** dispose() 済みか。破棄後にベースセッションを再生成して再リークさせないためのフラグ */
  let disposed = false;
  /** `clone()` 実行中のジョブ数。直列キューのため実質 0 か 1 */
  let cloningCount = 0;
  /** dispose() 時に clone() 実行中だった場合の destroy 待ちベースセッション */
  let pendingDestroySession: PromptSessionLike | null = null;

  /**
   * destroy 待ちのベースセッションを、clone() 実行中のジョブがいなければ destroy する。
   * clone() の途中で destroy すると clone() がブラウザ内部のエラーで失敗するため、
   * dispose() と clone() 完了の両方からこの関数を呼び、後に到達した方が破棄を実行する
   */
  function destroyPendingBaseSessionIfIdle(): void {
    if (!pendingDestroySession || cloningCount > 0) return;
    const session = pendingDestroySession;
    pendingDestroySession = null;
    try {
      session.destroy();
    } catch (error) {
      // destroy の失敗はネイティブセッションのリーク残存を意味するが、dispose の呼び出し元
      // (パイプラインの停止処理など)を巻き込まないよう、例外にせず警告として記録する
      console.warn("SessionPool: ベースセッションの destroy に失敗しました", error);
    }
  }

  function getBaseSession(): Promise<PromptSessionLike> {
    if (disposed) {
      return Promise.reject(new SessionPoolDisposedError());
    }
    if (!baseSessionPromise) {
      baseSessionPromise = deps.createBaseSession().catch((error: unknown) => {
        // 生成に失敗したら次回 enqueue 時に再試行できるようキャッシュを捨てる
        baseSessionPromise = null;
        throw error;
      });
    }
    return baseSessionPromise;
  }

  return {
    async warmUp() {
      await getBaseSession();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const promise = baseSessionPromise;
      baseSessionPromise = null;
      // 生成中でも、完了を待ってから destroy する(生成そのものは中断できないため)。
      // 拒否ハンドラは「生成失敗 = 破棄する対象が無い」場合専用で、destroy の失敗は
      // destroyPendingBaseSessionIfIdle が警告として記録する(暗黙に握りつぶさない)
      void promise?.then(
        (session) => {
          pendingDestroySession = session;
          destroyPendingBaseSessionIfIdle();
        },
        () => {},
      );
    },
    enqueue<T>(priority: JobPriority, run: (session: PromptSessionLike) => Promise<T>, signal?: AbortSignal): Promise<T> {
      // ベースセッションの生成・クローンもキューの中で行い、`LanguageModel.create()` を含めて直列にする
      return deps.queue.enqueue(
        priority,
        async () => {
          const baseSession = await getBaseSession();
          // clone() の途中で dispose() がベースセッションを destroy しないよう、clone 中を数えて破棄を遅延させる
          cloningCount += 1;
          let jobSession: PromptSessionLike;
          try {
            jobSession = await baseSession.clone();
          } finally {
            cloningCount -= 1;
            destroyPendingBaseSessionIfIdle();
          }
          try {
            return await run(jobSession);
          } finally {
            jobSession.destroy();
          }
        },
        signal,
      );
    },
  };
}
