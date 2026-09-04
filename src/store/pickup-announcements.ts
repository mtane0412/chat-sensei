/**
 * Pick up列で語句を削除したことをスクリーンリーダーへ通知するための、モジュールスコープのストア。
 *
 * 削除ボタン(`page.tsx` の PickupTermRow)は押されると自身が unmount されるため、
 * ボタン側では読み上げできない。代わりにホーム画面が常設する polite な aria-live リージョン
 * (`page.tsx` の PickupRemovalAnnouncement)がこのストアを購読し、削除のたびに
 * 「Removed "<語句>"」を表示してスクリーンリーダーに通知する(issue #73)。
 *
 * 同じ語句を連続で削除するとメッセージ文字列が変わらず、aria-live が変化を検知できないため、
 * 通知のたびに単調増加する通知番号(seq)を併せて保持する。表示側は seq の偶奇で
 * 不可視の文字を付け替え、DOM のテキスト変化を保証する。
 */
import { create } from "zustand";

interface PickupAnnouncementState {
  /** スクリーンリーダーへ通知するメッセージ。初期状態は空で何も通知しない */
  message: string;
  /** 通知のたびに増える通知番号。同一メッセージの連続通知を DOM の変化として区別するために使う */
  seq: number;
}

export const usePickupAnnouncementStore = create<PickupAnnouncementState>(() => ({ message: "", seq: 0 }));

/** 語句の削除をスクリーンリーダーへ通知する。自動抽出分・手動Pick up分の削除ボタンの両方から呼ぶ */
export function announcePickupRemoval(term: string): void {
  usePickupAnnouncementStore.setState((state) => ({ message: `Removed "${term}"`, seq: state.seq + 1 }));
}

/** 語句への「知っている」マーク(issue #110)をスクリーンリーダーへ通知する。✓ボタンから呼ぶ */
export function announcePickupKnown(term: string): void {
  usePickupAnnouncementStore.setState((state) => ({ message: `Marked "${term}" as known`, seq: state.seq + 1 }));
}

/** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetPickupAnnouncementStoreForTests(): void {
  usePickupAnnouncementStore.setState({ message: "", seq: 0 });
}
