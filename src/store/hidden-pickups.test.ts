/**
 * hidden-pickups ストアのテスト。
 *
 * ユーザーが Pick up 列から削除した語句(messageId × term)の集合を保持し、
 * 表示時の除外に使えることを検証する(issue #71)。
 * 自動パイプラインのエントリとは独立した状態なので、パイプライン再起動の影響を受けないこと自体は
 * ホーム画面のテスト(page.test.tsx)で検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { hidePickupTerm, resetHiddenPickupStoreForTests, useHiddenPickupStore } from "./hidden-pickups";

afterEach(() => {
  resetHiddenPickupStoreForTests();
});

describe("hidden-pickups ストア", () => {
  it("初期状態では非表示の語句を持たない", () => {
    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({});
  });

  it("hidePickupTerm で語句を発言IDごとの非表示集合へ追加する", () => {
    hidePickupTerm("msg-1", "gg");
    hidePickupTerm("msg-1", "no re");
    hidePickupTerm("msg-2", "gg");

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({
      "msg-1": ["gg", "no re"],
      "msg-2": ["gg"],
    });
  });

  it("同じ発言IDの同じ語句を重複して追加しない", () => {
    hidePickupTerm("msg-1", "gg");
    hidePickupTerm("msg-1", "gg");

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({ "msg-1": ["gg"] });
  });

  it("resetHiddenPickupStoreForTests で初期状態に戻る", () => {
    hidePickupTerm("msg-1", "gg");

    resetHiddenPickupStoreForTests();

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({});
  });
});
