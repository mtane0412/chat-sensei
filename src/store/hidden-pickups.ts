/**
 * ユーザーが Pick up 列から削除した語句(messageId × term)の集合を保持する、モジュールスコープのストア。
 *
 * 自動抽出パイプライン(`pickups.ts`)のエントリには手を入れず、非表示の語句を別の状態として持ち、
 * ホーム画面(`page.tsx` の PickupTerms)が表示時に除外する(issue #71)。
 * エントリを直接書き換えない理由: 言語設定変更・配信情報変化時にパイプラインが再起動し、
 * エントリは破棄・再生成されるため、書き換えた削除が再生成で復活してしまう。
 * このストアはパイプライン再起動で破棄しないので、再生成後も削除が維持される。
 *
 * 保持はセッション中のみ(LocalStorage への永続化はしない)。
 * 削除した語句を除外辞書に足して再抽出自体を防ぐ機能はスコープ外(issue #71 参照)。
 */
import { create } from "zustand";

interface HiddenPickupState {
  /** 発言IDごとの、削除(非表示)にした語句の一覧 */
  hiddenTerms: Readonly<Record<string, readonly string[]>>;
}

export const useHiddenPickupStore = create<HiddenPickupState>(() => ({ hiddenTerms: {} }));

/** 指定した発言の語句を非表示集合へ追加する。既に追加済みなら何もしない */
export function hidePickupTerm(messageId: string, term: string): void {
  useHiddenPickupStore.setState((state) => {
    const current = state.hiddenTerms[messageId] ?? [];
    if (current.includes(term)) return state;
    return { hiddenTerms: { ...state.hiddenTerms, [messageId]: [...current, term] } };
  });
}

/** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetHiddenPickupStoreForTests(): void {
  useHiddenPickupStore.setState({ hiddenTerms: {} });
}
