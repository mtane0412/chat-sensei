/**
 * src/lib/ai/session-pool.ts のテスト。
 *
 * Prompt API(Gemini Nano)はメインスレッドで動作しWeb Workerが使えないため、
 * 単一のベースセッション + 優先度付き直列キューでUIをブロックしないよう制御する。
 * 実際の LanguageModel は使わず、フェイクセッション(手動で resolve/reject できる
 * Deferred Promise)を注入して、直列性・優先度・キュー溢れ・中断を検証する。
 */
import { describe, expect, it, vi } from "vitest";
import { createSessionPool, LowPriorityQueueOverflowError, type PromptSessionLike } from "./session-pool";

/**
 * キューは `getBaseSession()` → `clone()` → `run()` と複数回 await を挟んでから
 * ジョブ本体を実行するため、マイクロタスクを十分な回数フラッシュしてから
 * 「まだ実行されていないこと」を確認する。
 */
async function flushMicrotasks(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

/** テストから任意のタイミングで resolve/reject できる Promise (Deferred パターン) */
function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** フェイクの PromptSessionLike。clone() のたびに新しいフェイクを返し、呼び出し履歴を記録する */
function createFakeSession(log: string[], label: string): PromptSessionLike {
  return {
    prompt: vi.fn(async () => `response from ${label}`),
    clone: vi.fn(async () => {
      log.push(`clone:${label}`);
      return createFakeSession(log, `${label}-clone${log.length}`);
    }),
    destroy: vi.fn(() => {
      log.push(`destroy:${label}`);
    }),
  };
}

describe("createSessionPool", () => {
  it("enqueueしたジョブにクローンしたセッションを渡し、成功後にクローンをdestroyする", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createSessionPool({ createBaseSession: async () => baseSession });

    const result = await pool.enqueue("high", async (session) => {
      const text = await session.prompt("hello");
      return text;
    });

    expect(result).toBe("response from base-clone1");
    expect(log).toEqual(["clone:base", "destroy:base-clone1"]);
    expect(baseSession.destroy).not.toHaveBeenCalled(); // ベースセッション自体は使い回すため破棄しない
  });

  it("複数ジョブは同時実行せず、前のジョブが完了してから次を実行する(直列性)", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createSessionPool({ createBaseSession: async () => baseSession });
    const deferred1 = createDeferred<string>();

    const order: string[] = [];
    const p1 = pool.enqueue("high", async () => {
      order.push("job1:start");
      const result = await deferred1.promise;
      order.push("job1:end");
      return result;
    });
    const p2 = pool.enqueue("high", async () => {
      order.push("job2:start");
      return "job2 result";
    });

    // job1がまだ完了していない間は job2 は開始しない
    await flushMicrotasks();
    expect(order).toEqual(["job1:start"]);

    deferred1.resolve("job1 result");
    expect(await p1).toBe("job1 result");
    expect(await p2).toBe("job2 result");
    expect(order).toEqual(["job1:start", "job1:end", "job2:start"]);
  });

  it("高優先度ジョブは、待機中の低優先度ジョブより先に実行される", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createSessionPool({ createBaseSession: async () => baseSession });
    const blocker = createDeferred<string>();

    const order: string[] = [];
    // 最初のジョブでキューを埋めて、その間に低優先度→高優先度の順でenqueueする
    const pBlocking = pool.enqueue("high", async () => {
      order.push("blocking:start");
      await blocker.promise;
      order.push("blocking:end");
      return "blocking done";
    });
    await Promise.resolve();

    const pLow = pool.enqueue("low", async () => {
      order.push("low:run");
      return "low result";
    });
    const pHigh = pool.enqueue("high", async () => {
      order.push("high:run");
      return "high result";
    });

    blocker.resolve("released");
    await pBlocking;
    await pHigh;
    await pLow;

    expect(order).toEqual(["blocking:start", "blocking:end", "high:run", "low:run"]);
  });

  it("低優先度キューが上限を超えた場合、最も古い低優先度ジョブを破棄する(高優先度は破棄しない)", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createSessionPool({ createBaseSession: async () => baseSession, maxLowPriorityQueueLength: 2 });
    const blocker = createDeferred<string>();

    // ジョブ実行中にしてキューが溜まる状況を作る
    const pBlocking = pool.enqueue("high", async () => {
      await blocker.promise;
      return "blocking done";
    });
    await Promise.resolve();

    const pLow1 = pool.enqueue("low", async () => "low1");
    const pLow2 = pool.enqueue("low", async () => "low2");
    const pLow3 = pool.enqueue("low", async () => "low3"); // 上限(2)を超えるため low1 が破棄される

    // 呼び出し側が「流量超過で未翻訳」など溢れ固有の表示に切り替えられるよう、専用エラーで拒否する
    await expect(pLow1).rejects.toBeInstanceOf(LowPriorityQueueOverflowError);
    blocker.resolve("released");
    await pBlocking;

    expect(await pLow2).toBe("low2");
    expect(await pLow3).toBe("low3");
  });

  it("既にabort済みのsignalを渡した場合、キューに積まずに即座に拒否する", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const createBaseSession = vi.fn(async () => baseSession);
    const pool = createSessionPool({ createBaseSession });
    const controller = new AbortController();
    controller.abort();

    const run = vi.fn(async () => "should not run");
    await expect(pool.enqueue("high", run, controller.signal)).rejects.toThrow();

    expect(run).not.toHaveBeenCalled();
    expect(createBaseSession).not.toHaveBeenCalled();
  });

  it("待機中にsignalがabortされたジョブは実行されず拒否され、他のジョブには影響しない", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createSessionPool({ createBaseSession: async () => baseSession });
    const blocker = createDeferred<string>();
    const controller = new AbortController();

    const pBlocking = pool.enqueue("high", async () => {
      await blocker.promise;
      return "blocking done";
    });
    await Promise.resolve();

    const abortedRun = vi.fn(async () => "should not run");
    const pAborted = pool.enqueue("high", abortedRun, controller.signal);
    const pNormal = pool.enqueue("high", async () => "normal result");

    controller.abort();
    blocker.resolve("released");
    await pBlocking;

    await expect(pAborted).rejects.toThrow();
    expect(abortedRun).not.toHaveBeenCalled();
    expect(await pNormal).toBe("normal result");
  });

  it("ベースセッションの生成に失敗した場合はジョブを拒否し、次回enqueue時に再生成を試みる", async () => {
    const log: string[] = [];
    const createBaseSession = vi
      .fn()
      .mockRejectedValueOnce(new Error("モデルが利用できません"))
      .mockResolvedValueOnce(createFakeSession(log, "base"));
    const pool = createSessionPool({ createBaseSession });

    await expect(pool.enqueue("high", async () => "x")).rejects.toThrow("モデルが利用できません");

    const result = await pool.enqueue("high", async (session) => session.prompt("retry"));
    expect(result).toBe("response from base-clone1");
    expect(createBaseSession).toHaveBeenCalledTimes(2);
  });
});
