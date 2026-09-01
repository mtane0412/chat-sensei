/**
 * src/lib/ai/session-pool.ts のテスト。
 *
 * Prompt API(Gemini Nano)はメインスレッドで動作しWeb Workerが使えないため、
 * 用途ごとのベースセッション + アプリ全体で 1 つの優先度付き直列キュー(`createPromptJobQueue`)で
 * UIをブロックしないよう制御する。
 * 実際の LanguageModel は使わず、フェイクセッション(手動で resolve/reject できる
 * Deferred Promise)を注入して、直列性・優先度・キュー溢れ・中断・複数プール間のキュー共有(issue #23)を検証する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  createPromptJobQueue,
  createSessionPool,
  LowPriorityQueueOverflowError,
  type PromptJobQueue,
  type PromptSessionLike,
} from "./session-pool";

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

/** テスト用にプールを 1 つ作る。キューを省略した場合はそのプール専用のキューを新しく作る */
function createPool(createBaseSession: () => Promise<PromptSessionLike>, queue: PromptJobQueue = createPromptJobQueue()) {
  return createSessionPool({ createBaseSession, queue });
}

describe("createSessionPool", () => {
  it("enqueueしたジョブにクローンしたセッションを渡し、成功後にクローンをdestroyする", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const pool = createPool(async () => baseSession);

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
    const pool = createPool(async () => baseSession);
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
    const pool = createPool(async () => baseSession);
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
    const pool = createPool(async () => baseSession, createPromptJobQueue({ maxLowPriorityQueueLength: 2 }));
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
    const pool = createPool(createBaseSession);
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
    const pool = createPool(async () => baseSession);
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
    const pool = createPool(createBaseSession);

    await expect(pool.enqueue("high", async () => "x")).rejects.toThrow("モデルが利用できません");

    const result = await pool.enqueue("high", async (session) => session.prompt("retry"));
    expect(result).toBe("response from base-clone1");
    expect(createBaseSession).toHaveBeenCalledTimes(2);
  });

  it("warmUp() はジョブを積まずにベースセッションを生成し、以後の enqueue はそのセッションを使い回す", async () => {
    const log: string[] = [];
    const baseSession = createFakeSession(log, "base");
    const createBaseSession = vi.fn(async () => baseSession);
    const pool = createPool(createBaseSession);

    await pool.warmUp();
    expect(createBaseSession).toHaveBeenCalledTimes(1);
    expect(log).toEqual([]); // clone/destroy は行わない

    await pool.enqueue("high", async (session) => session.prompt("hello"));
    expect(createBaseSession).toHaveBeenCalledTimes(1);
  });

  it("warmUp() でベースセッション生成に失敗した場合はその例外をそのまま投げる", async () => {
    const pool = createPool(async () => {
      throw new Error("ユーザー操作なしではモデルをダウンロードできません");
    });

    await expect(pool.warmUp()).rejects.toThrow("ユーザー操作なしではモデルをダウンロードできません");
  });
});

/**
 * issue #23: 翻訳用・Pick up 用のようにベースセッション(システムプロンプト)が異なるプールでも、
 * 同じキューを共有していれば Gemini Nano への呼び出しはアプリ全体で常に 1 つずつになること。
 */
describe("createSessionPool: 複数プールでのキュー共有(issue #23)", () => {
  it("同じキューを共有する 2 つのプールのジョブは並走せず、積んだ順に直列で実行される", async () => {
    const log: string[] = [];
    const queue = createPromptJobQueue();
    const translatePool = createPool(async () => createFakeSession(log, "translate-base"), queue);
    const pickupPool = createPool(async () => createFakeSession(log, "pickup-base"), queue);
    const blocker = createDeferred<string>();

    const order: string[] = [];
    const pTranslate = translatePool.enqueue("low", async () => {
      order.push("translate:start");
      await blocker.promise;
      order.push("translate:end");
      return "翻訳結果";
    });
    const pPickup = pickupPool.enqueue("low", async () => {
      order.push("pickup:start");
      return "抽出結果";
    });

    // 翻訳ジョブが完了するまで、別プールの Pick up ジョブは開始しない
    await flushMicrotasks();
    expect(order).toEqual(["translate:start"]);

    blocker.resolve("released");
    expect(await pTranslate).toBe("翻訳結果");
    expect(await pPickup).toBe("抽出結果");
    expect(order).toEqual(["translate:start", "translate:end", "pickup:start"]);
  });

  it("各プールは自分のベースセッションからクローンしてジョブに渡す(キューを共有してもセッションは混ざらない)", async () => {
    const log: string[] = [];
    const queue = createPromptJobQueue();
    const translateBase = createFakeSession(log, "translate-base");
    const pickupBase = createFakeSession(log, "pickup-base");
    const translatePool = createPool(async () => translateBase, queue);
    const pickupPool = createPool(async () => pickupBase, queue);

    const translateResult = await translatePool.enqueue("low", (session) => session.prompt("gg"));
    const pickupResult = await pickupPool.enqueue("low", (session) => session.prompt("gg"));

    expect(translateResult).toMatch(/^response from translate-base-clone/);
    expect(pickupResult).toMatch(/^response from pickup-base-clone/);
  });

  it("高優先度ジョブは、別プールで待機中の低優先度ジョブより先に実行される", async () => {
    const log: string[] = [];
    const queue = createPromptJobQueue();
    const translatePool = createPool(async () => createFakeSession(log, "translate-base"), queue);
    const pickupPool = createPool(async () => createFakeSession(log, "pickup-base"), queue);
    const blocker = createDeferred<string>();

    const order: string[] = [];
    const pBlocking = translatePool.enqueue("low", async () => {
      await blocker.promise;
      return "blocking done";
    });
    await Promise.resolve();

    const pLow = translatePool.enqueue("low", async () => {
      order.push("translate:low");
      return "low";
    });
    const pHigh = pickupPool.enqueue("high", async () => {
      order.push("pickup:high");
      return "high";
    });

    blocker.resolve("released");
    await pBlocking;
    await pHigh;
    await pLow;

    expect(order).toEqual(["pickup:high", "translate:low"]);
  });

  it("低優先度キューの上限はキューを共有するプール全体で 1 つであり、溢れた場合はプールを問わず最も古いジョブを破棄する", async () => {
    const log: string[] = [];
    const queue = createPromptJobQueue({ maxLowPriorityQueueLength: 2 });
    const translatePool = createPool(async () => createFakeSession(log, "translate-base"), queue);
    const pickupPool = createPool(async () => createFakeSession(log, "pickup-base"), queue);
    const blocker = createDeferred<string>();

    const pBlocking = translatePool.enqueue("high", async () => {
      await blocker.promise;
      return "blocking done";
    });
    await Promise.resolve();

    const pTranslate1 = translatePool.enqueue("low", async () => "translate1");
    const pPickup1 = pickupPool.enqueue("low", async () => "pickup1");
    const pTranslate2 = translatePool.enqueue("low", async () => "translate2"); // 上限(2)を超えるため translate1 が破棄される

    await expect(pTranslate1).rejects.toBeInstanceOf(LowPriorityQueueOverflowError);
    blocker.resolve("released");
    await pBlocking;

    expect(await pPickup1).toBe("pickup1");
    expect(await pTranslate2).toBe("translate2");
  });
});
