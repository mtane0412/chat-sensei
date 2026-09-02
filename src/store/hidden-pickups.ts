/**
 * ユーザーが Pick up 列から削除した語句(messageId × term)の集合を保持する、モジュールスコープのストア。
 *
 * 自動抽出パイプライン(`pickups.ts`)のエントリには手を入れず、非表示の語句を別の状態として持ち、
 * ホーム画面(`page.tsx` の PickupTerms)が表示時に除外する(issue #71)。
 * エントリを直接書き換えない理由: 言語設定変更・配信情報変化時にパイプラインが再起動し、
 * エントリは破棄・再生成されるため、書き換えた削除が再生成で復活してしまう。
 * このストアはパイプライン再起動で破棄しないので、再生成後も削除が維持される。
 *
 * 語句は正準形(trim + 小文字化。`pickup-filter.ts` の重複排除と同じ基準)で保持・照合する。
 * パイプライン再起動時は LLM が抽出をやり直すため、同じ語句でも綴り(大文字小文字・前後空白)が
 * 揺れることがあり、生文字列の完全一致では削除した語句が復活してしまうため。
 *
 * 保持はセッション中のみ(LocalStorage への永続化はしない)。チャンネル切り替え時は
 * `chat-connection.ts` の connect() が `clearHiddenPickupTerms()` で破棄する(前のチャンネルの
 * 発言IDは二度と参照されず、持ち越すとメモリを浪費するだけのため)。
 * 削除した語句を除外辞書に足して再抽出自体を防ぐ機能はスコープ外(issue #71 参照)。
 */
import { create } from "zustand";

interface HiddenPickupState {
  /** 発言IDごとの、削除(非表示)にした語句の一覧 */
  hiddenTerms: Readonly<Record<string, readonly string[]>>;
}

export const useHiddenPickupStore = create<HiddenPickupState>(() => ({ hiddenTerms: {} }));

/** 語句の正準形。`pickup-filter.ts` の重複排除と同じ基準で、LLM 再生成による綴り揺れを吸収する */
function normalizeTerm(term: string): string {
  return term.trim().toLowerCase();
}

/** 指定した発言の語句を正準形で非表示集合へ追加する。既に追加済みなら何もしない */
export function hidePickupTerm(messageId: string, term: string): void {
  const normalized = normalizeTerm(term);
  useHiddenPickupStore.setState((state) => {
    const current = state.hiddenTerms[messageId] ?? [];
    if (current.includes(normalized)) return state;
    return { hiddenTerms: { ...state.hiddenTerms, [messageId]: [...current, normalized] } };
  });
}

/** 非表示集合(`hiddenTerms[messageId]`)に語句が含まれるか。綴り揺れを正準形で吸収して照合する */
export function isPickupTermHidden(hiddenTerms: readonly string[], term: string): boolean {
  return hiddenTerms.includes(normalizeTerm(term));
}

/** 非表示集合をすべて破棄する。チャンネル切り替え時(`chat-connection.ts` の connect())に呼ぶ */
export function clearHiddenPickupTerms(): void {
  useHiddenPickupStore.setState({ hiddenTerms: {} });
}

/** テスト専用: ストアを初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetHiddenPickupStoreForTests(): void {
  useHiddenPickupStore.setState({ hiddenTerms: {} });
}
