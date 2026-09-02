/**
 * manual-pickups ストアのテスト。
 *
 * ユーザーが範囲選択で手動Pick upした語句(messageId × term)とその意味生成の状態を、
 * 自動抽出パイプライン(`pickups.ts`)とは別のストアとして保持できることを検証する(issue #72)。
 * 意味の生成(LLM 呼び出し)と Prompt API の利用可否はフェイクを注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionPoolDisposedError, type PromptSessionLike } from "@/lib/ai/session-pool";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import {
  addManualPickup,
  clearManualPickups,
  removeManualPickup,
  resetManualPickupStoreForTests,
  useManualPickupStore,
  type ManualPickupDeps,
} from "./manual-pickups";
import { flush } from "./pipeline-test-fixtures";
import { resetPromptApiStoreForTests, usePromptApiStore } from "./prompt-api";
import { resetSettingsStoreForTests, useSettingsStore } from "./settings";

/**
 * getDefineTermPool(セッションプールの差し替え)を検証するために define-term をモックする(issue #75)。
 * デフォルト依存(deps を省略した呼び出し)だけがこのモックに到達し、
 * ManualPickupDeps を注入する既存テストの経路には影響しない。
 */
const defineTermMockState = vi.hoisted(() => {
  /** createDefineTermBaseSessionFactory が生成したフェイクのベースセッションの破棄記録(生成順) */
  const createdBaseSessions: Array<{ destroyCount: number }> = [];
  return { createdBaseSessions };
});

vi.mock("@/lib/ai/define-term", () => ({
  createDefineTermBaseSessionFactory: () => async (): Promise<PromptSessionLike> => {
    const tracker = { destroyCount: 0 };
    defineTermMockState.createdBaseSessions.push(tracker);
    const session: PromptSessionLike = {
      prompt: async () => "モックの応答",
      clone: async () => session,
      destroy: () => {
        tracker.destroyCount += 1;
      },
    };
    return session;
  },
  defineTerm: async () => ({ meaning: "モックが生成した意味" }),
}));

function createDeps(overrides: Partial<ManualPickupDeps> = {}): ManualPickupDeps {
  return {
    getPromptApiStatus: () => ({ status: "ready" }),
    generateMeaning: vi.fn(async () => "生成された意味"),
    ...overrides,
  };
}

afterEach(() => {
  resetManualPickupStoreForTests();
});

describe("manual-pickups ストア", () => {
  it("初期状態では手動Pick upを持たない", () => {
    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("追加するとまず pending になり、意味の生成完了で done になる", async () => {
    let resolveMeaning!: (meaning: string) => void;
    const deps = createDeps({
      generateMeaning: () =>
        new Promise<string>((resolve) => {
          resolveMeaning = resolve;
        }),
    });

    const promise = addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([{ status: "pending", term: "no re" }]);

    resolveMeaning("リマッチは無しという潔い挨拶");
    await promise;

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "done", term: "no re", meaning: "リマッチは無しという潔い挨拶" },
    ]);
  });

  it("generateMeaning には選択した語句・発言本文・中断用の signal を渡す", async () => {
    const deps = createDeps();

    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(deps.generateMeaning).toHaveBeenCalledWith("no re", "gg no re chat", expect.any(AbortSignal));
  });

  it("意味の生成に失敗した場合は理由付きの failed になる(暗黙に隠さない)", async () => {
    const deps = createDeps({
      generateMeaning: vi.fn(async () => {
        throw new Error("モデル呼び出しに失敗しました");
      }),
    });

    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "failed", term: "no re", reason: "モデル呼び出しに失敗しました" },
    ]);
  });

  it("Prompt API が利用できない環境では生成を試みず、理由付きの failed として保持する", async () => {
    const deps = createDeps({
      getPromptApiStatus: () => ({ status: "unavailable", reason: "The Prompt API is not available." }),
    });

    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(deps.generateMeaning).not.toHaveBeenCalled();
    const entries = useManualPickupStore.getState().entries["msg-1"];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ status: "failed", term: "no re" });
  });

  it("語句を trim して保持し、前後の空白だけが違う語句は重複として追加しない", async () => {
    const deps = createDeps();

    await addManualPickup("msg-1", " no re ", "gg no re chat", deps);
    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "done", term: "no re", meaning: "生成された意味" },
    ]);
    expect(deps.generateMeaning).toHaveBeenCalledTimes(1);
  });

  it("大文字小文字だけが違う語句は重複として追加しない(hidden-pickups と同じ正準形の基準)", async () => {
    const deps = createDeps();

    await addManualPickup("msg-1", "GG", "GG everyone", deps);
    await addManualPickup("msg-1", "gg", "GG everyone", deps);

    expect(useManualPickupStore.getState().entries["msg-1"]).toHaveLength(1);
  });

  it("空白のみの語句は追加しない", async () => {
    const deps = createDeps();

    await addManualPickup("msg-1", "   ", "gg no re chat", deps);

    expect(useManualPickupStore.getState().entries).toEqual({});
    expect(deps.generateMeaning).not.toHaveBeenCalled();
  });

  it("生成完了前にクリアされた場合は、遅れて届いた結果を反映しない(チャンネル切替を想定)", async () => {
    let resolveMeaning!: (meaning: string) => void;
    const deps = createDeps({
      generateMeaning: () =>
        new Promise<string>((resolve) => {
          resolveMeaning = resolve;
        }),
    });
    const promise = addManualPickup("msg-1", "no re", "gg no re chat", deps);

    clearManualPickups();
    resolveMeaning("遅れて届いた意味");
    await promise;

    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("失敗した語句を再度追加すると、failed エントリを置き換えて生成をやり直す(issue #72 レビュー C1)", async () => {
    const failing = createDeps({
      generateMeaning: vi.fn(async () => {
        throw new Error("一時的なエラー");
      }),
    });
    await addManualPickup("msg-1", "no re", "gg no re chat", failing);
    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "failed", term: "no re", reason: "一時的なエラー" },
    ]);

    const succeeding = createDeps();
    await addManualPickup("msg-1", "no re", "gg no re chat", succeeding);

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "done", term: "no re", meaning: "生成された意味" },
    ]);
  });

  it("pending・done の語句は重複として扱い、再試行しない", async () => {
    let resolveMeaning!: (meaning: string) => void;
    const deps = createDeps({
      generateMeaning: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            resolveMeaning = resolve;
          }),
      ),
    });
    const promise = addManualPickup("msg-1", "no re", "gg no re chat", deps);

    await addManualPickup("msg-1", "no re", "gg no re chat", deps); // pending 中の重複

    expect(deps.generateMeaning).toHaveBeenCalledTimes(1);
    resolveMeaning("意味");
    await promise;
  });

  it("removeManualPickup で pending の語句を削除すると、生成ジョブの signal を中断する(issue #72 レビュー C3)", async () => {
    let capturedSignal: AbortSignal | undefined;
    const deps = createDeps({
      generateMeaning: vi.fn(
        (_term: string, _messageText: string, signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            capturedSignal = signal;
            signal?.addEventListener("abort", () => reject(new Error("中断されました")), { once: true });
          }),
      ),
    });
    const promise = addManualPickup("msg-1", "no re", "gg no re chat", deps);

    removeManualPickup("msg-1", "no re");
    await promise;

    expect(capturedSignal?.aborted).toBe(true);
    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("clearManualPickups で pending の生成ジョブをすべて中断する(issue #72 レビュー C3)", async () => {
    const capturedSignals: (AbortSignal | undefined)[] = [];
    const deps = createDeps({
      generateMeaning: vi.fn(
        (_term: string, _messageText: string, signal?: AbortSignal) =>
          new Promise<string>((_resolve, reject) => {
            capturedSignals.push(signal);
            signal?.addEventListener("abort", () => reject(new Error("中断されました")), { once: true });
          }),
      ),
    });
    const promise1 = addManualPickup("msg-1", "no re", "gg no re chat", deps);
    const promise2 = addManualPickup("msg-2", "gg", "gg everyone", deps);

    clearManualPickups();
    await Promise.all([promise1, promise2]);

    expect(capturedSignals.map((signal) => signal?.aborted)).toEqual([true, true]);
    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("removeManualPickup で指定した語句だけを削除する", async () => {
    const deps = createDeps();
    await addManualPickup("msg-1", "no re", "gg no re chat", deps);
    await addManualPickup("msg-1", "gg", "gg no re chat", deps);

    removeManualPickup("msg-1", "no re");

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      { status: "done", term: "gg", meaning: "生成された意味" },
    ]);
  });

  it("removeManualPickup で最後の語句を削除した発言は、エントリごと消える", async () => {
    const deps = createDeps();
    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    removeManualPickup("msg-1", "no re");

    expect(useManualPickupStore.getState().entries).toEqual({});
  });

  it("プール差し替えで破棄されたジョブは、内部文言ではなく再試行を促す理由の failed になる(issue #75)", async () => {
    const deps = createDeps({
      generateMeaning: vi.fn(async () => {
        throw new SessionPoolDisposedError();
      }),
    });

    await addManualPickup("msg-1", "gg", "gg chat", deps);

    expect(useManualPickupStore.getState().entries["msg-1"]).toEqual([
      {
        status: "failed",
        term: "gg",
        reason: "Cancelled because the settings or stream context changed. Select the term again to retry.",
      },
    ]);
  });

  it("clearManualPickups で全発言の手動Pick upを破棄する", async () => {
    const deps = createDeps();
    await addManualPickup("msg-1", "no re", "gg no re chat", deps);
    await addManualPickup("msg-2", "gg", "gg everyone", deps);

    clearManualPickups();

    expect(useManualPickupStore.getState().entries).toEqual({});
  });
});

/**
 * issue #75: 設定・配信情報の変化でセッションプールを差し替えるとき、旧プールのウォームアップ済み
 * ベースセッション(Gemini Nano のネイティブセッション)を破棄し、リークさせないこと。
 * デフォルト依存(deps 省略)で getDefineTermPool を経由させるため、define-term をモックしている。
 */
describe("getDefineTermPool: プール差し替え時の破棄(issue #75)", () => {
  /** デフォルト依存が参照する設定ストア・Prompt API ストアを「利用可能」な状態にする */
  function setUpDefaultDepsEnvironment() {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: true });
    usePromptApiStore.setState({ status: { status: "ready" } });
  }

  afterEach(() => {
    defineTermMockState.createdBaseSessions.length = 0;
    resetSettingsStoreForTests();
    resetPromptApiStoreForTests();
  });

  it("設定が同じ間はプールを使い回し、ベースセッションを破棄しない", async () => {
    setUpDefaultDepsEnvironment();

    await addManualPickup("msg-1", "gg", "gg chat");
    await addManualPickup("msg-2", "poggers", "poggers wow");
    await flush();

    expect(defineTermMockState.createdBaseSessions).toHaveLength(1);
    expect(defineTermMockState.createdBaseSessions[0].destroyCount).toBe(0);
  });

  it("設定が変わって新しいプールを作るとき、旧プールのベースセッションを destroy する", async () => {
    setUpDefaultDepsEnvironment();
    await addManualPickup("msg-1", "gg", "gg chat");
    await flush();
    expect(defineTermMockState.createdBaseSessions).toHaveLength(1);

    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, explainLang: "es" }, hydrated: true });
    await addManualPickup("msg-2", "poggers", "poggers wow");
    await flush();

    expect(defineTermMockState.createdBaseSessions).toHaveLength(2);
    expect(defineTermMockState.createdBaseSessions[0].destroyCount).toBe(1); // 旧プールは破棄する
    expect(defineTermMockState.createdBaseSessions[1].destroyCount).toBe(0); // 新プールは使い続ける
  });

  it("clearManualPickups はキャッシュ中のプールのベースセッションを破棄する(チャンネル切替時のリーク防止)", async () => {
    setUpDefaultDepsEnvironment();
    await addManualPickup("msg-1", "gg", "gg chat");
    await flush();

    clearManualPickups();
    await flush();

    expect(defineTermMockState.createdBaseSessions[0].destroyCount).toBe(1);
  });

  it("resetManualPickupStoreForTests はキャッシュ中のプールのベースセッションを破棄する", async () => {
    setUpDefaultDepsEnvironment();
    await addManualPickup("msg-1", "gg", "gg chat");
    await flush();

    resetManualPickupStoreForTests();
    await flush();

    expect(defineTermMockState.createdBaseSessions[0].destroyCount).toBe(1);
  });
});
