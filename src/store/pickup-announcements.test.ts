/**
 * src/store/pickup-announcements.ts(Pick up語句削除のスクリーンリーダー通知ストア)のテスト。
 *
 * 削除された語句が「Removed "<語句>"」の形でメッセージになること、
 * 同じ語句を連続で削除しても aria-live が変化を検知できるよう通知番号(seq)が
 * 単調増加すること、テスト用リセットで初期状態に戻ることを検証する(issue #73)。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  announcePickupKnown,
  announcePickupRemoval,
  resetPickupAnnouncementStoreForTests,
  usePickupAnnouncementStore,
} from "./pickup-announcements";

afterEach(() => {
  resetPickupAnnouncementStoreForTests();
});

describe("announcePickupRemoval", () => {
  it('削除した語句を「Removed "<語句>"」のメッセージとして保持する', () => {
    announcePickupRemoval("gg");
    expect(usePickupAnnouncementStore.getState().message).toBe('Removed "gg"');
  });

  it("同じ語句を連続で削除しても通知番号(seq)が増え、通知の変化として区別できる", () => {
    announcePickupRemoval("gg");
    const 一回目 = usePickupAnnouncementStore.getState().seq;
    announcePickupRemoval("gg");
    const 二回目 = usePickupAnnouncementStore.getState().seq;
    expect(二回目).toBeGreaterThan(一回目);
  });

  it("初期状態ではメッセージが空で、何も通知しない", () => {
    expect(usePickupAnnouncementStore.getState().message).toBe("");
    expect(usePickupAnnouncementStore.getState().seq).toBe(0);
  });

  it("テスト用リセットで初期状態に戻る", () => {
    announcePickupRemoval("gg");
    resetPickupAnnouncementStoreForTests();
    expect(usePickupAnnouncementStore.getState().message).toBe("");
    expect(usePickupAnnouncementStore.getState().seq).toBe(0);
  });
});

describe("announcePickupKnown", () => {
  it('通知すると「Marked "<語句>" as known」のメッセージと通知番号の増加が反映される(issue #110)', () => {
    announcePickupKnown("gg");
    expect(usePickupAnnouncementStore.getState().message).toBe('Marked "gg" as known');
    expect(usePickupAnnouncementStore.getState().seq).toBe(1);
  });
});
