/**
 * manual-pickups ストアのテスト。
 *
 * ユーザーが範囲選択で手動Pick upした語句(messageId × term)とその意味生成の状態を、
 * 自動抽出パイプライン(`pickups.ts`)とは別のストアとして保持できることを検証する(issue #72)。
 * 意味の生成(LLM 呼び出し)と Prompt API の利用可否はフェイクを注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addManualPickup,
  clearManualPickups,
  removeManualPickup,
  resetManualPickupStoreForTests,
  useManualPickupStore,
  type ManualPickupDeps,
} from "./manual-pickups";

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

  it("generateMeaning には選択した語句と発言本文を渡す", async () => {
    const deps = createDeps();

    await addManualPickup("msg-1", "no re", "gg no re chat", deps);

    expect(deps.generateMeaning).toHaveBeenCalledWith("no re", "gg no re chat");
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

  it("clearManualPickups で全発言の手動Pick upを破棄する", async () => {
    const deps = createDeps();
    await addManualPickup("msg-1", "no re", "gg no re chat", deps);
    await addManualPickup("msg-2", "gg", "gg everyone", deps);

    clearManualPickups();

    expect(useManualPickupStore.getState().entries).toEqual({});
  });
});
