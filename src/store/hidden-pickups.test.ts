/**
 * hidden-pickups ストアのテスト。
 *
 * ユーザーが Pick up 列から削除した語句(messageId × term)の集合を保持し、
 * 表示時の除外に使えることを検証する(issue #71)。
 * 自動パイプラインのエントリとは独立した状態なので、パイプライン再起動の影響を受けないこと自体は
 * ホーム画面のテスト(page.test.tsx)で検証する。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  clearHiddenPickupTerms,
  hidePickupTerm,
  isPickupTermHidden,
  resetHiddenPickupStoreForTests,
  useHiddenPickupStore,
} from "./hidden-pickups";

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

  it("語句を正準形(trim + 小文字化。pickup-filter と同じ基準)に揃えて保持する", () => {
    hidePickupTerm("msg-1", " GG ");
    hidePickupTerm("msg-1", "gg");

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({ "msg-1": ["gg"] });
  });

  it("isPickupTermHidden は綴り(大文字小文字・前後空白)が違っても同じ語句なら true を返す", () => {
    hidePickupTerm("msg-1", "gg");

    expect(isPickupTermHidden(["gg"], "GG ")).toBe(true);
    expect(isPickupTermHidden(["gg"], "no re")).toBe(false);
  });

  it("clearHiddenPickupTerms で非表示集合をすべて破棄する(チャンネル切り替え時に呼ぶ)", () => {
    hidePickupTerm("msg-1", "gg");

    clearHiddenPickupTerms();

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({});
  });

  it("resetHiddenPickupStoreForTests で初期状態に戻る", () => {
    hidePickupTerm("msg-1", "gg");

    resetHiddenPickupStoreForTests();

    expect(useHiddenPickupStore.getState().hiddenTerms).toEqual({});
  });
});
