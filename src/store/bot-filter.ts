/**
 * チャット欄から除外する bot のユーザー名パターンを保持する、モジュールスコープのストア。
 *
 * パターンの正本は LocalStorage(`lib/bot-filter.ts`)だが、発言を受信するたびに
 * LocalStorage を読むのは無駄なので、Zustand ストアにキャッシュして参照する。
 *
 * SSR 中(Next.js のプリレンダリング)に LocalStorage へ触れないよう、ストアの初期値は
 * 空にしておき、ブラウザ側で `hydrateBotFilterStore()` を呼んだときに初めて復元する。
 * 復元は1度だけ行い、以後の変更は `setPatterns` 経由でストアと LocalStorage の両方へ書き込む。
 *
 * 受信した発言への適用(除外)は `chat-connection.ts` が担う(依存方向は chat-connection → bot-filter)。
 */
import { create } from "zustand";
import { loadBotFilterPatterns, matchesBotFilter, saveBotFilterPatterns } from "@/lib/bot-filter";

interface BotFilterState {
  /** 除外するユーザー名パターン(`*` ワイルドカード可、小文字) */
  patterns: readonly string[];
  /** LocalStorage からの復元が済んでいるか */
  hydrated: boolean;
  /** 復元時に保存データが壊れていて、デフォルトに戻したか(設定画面で利用者に伝える) */
  wasCorrupted: boolean;
  /** パターンを更新し、LocalStorage にも保存する */
  setPatterns: (patterns: readonly string[]) => void;
}

export const useBotFilterStore = create<BotFilterState>((set) => ({
  patterns: [],
  hydrated: false,
  wasCorrupted: false,
  setPatterns: (patterns) => {
    saveBotFilterPatterns(patterns);
    // 保存に成功した時点で LocalStorage は正常な値になっているため、壊れていた印は下ろす。
    // ストアが正本の値を持った状態になるので、復元済み扱いにする
    set({ patterns, wasCorrupted: false, hydrated: true });
  },
}));

/** LocalStorage から除外パターンを復元する。既に復元済みなら何もしない(ブラウザ環境でのみ呼ぶこと) */
export function hydrateBotFilterStore(): void {
  if (useBotFilterStore.getState().hydrated) return;
  const { patterns, wasCorrupted } = loadBotFilterPatterns();
  useBotFilterStore.setState({ patterns, wasCorrupted, hydrated: true });
}

/** ユーザー名が現在の除外パターンに一致するか。未復元なら先に復元する */
export function isExcludedByBotFilter(username: string): boolean {
  hydrateBotFilterStore();
  return matchesBotFilter(username, useBotFilterStore.getState().patterns);
}

/** テスト専用: ストアを初期状態(未復元)に戻す。各テストの beforeEach で呼び出すこと */
export function resetBotFilterStoreForTests(): void {
  useBotFilterStore.setState({ patterns: [], hydrated: false, wasCorrupted: false });
}
