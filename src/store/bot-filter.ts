/**
 * チャット欄から除外する bot のユーザー名パターンと、配信者自身の発言を除外するトグルを保持する、
 * モジュールスコープのストア。
 *
 * 設定の正本は LocalStorage(`lib/bot-filter.ts`)だが、発言を受信するたびに
 * LocalStorage を読むのは無駄なので、Zustand ストアにキャッシュして参照する。
 *
 * SSR 中(Next.js のプリレンダリング)に LocalStorage へ触れないよう、ストアの初期値は
 * 空にしておき、ブラウザ側で `hydrateBotFilterStore()` を呼んだときに初めて復元する。
 * 復元は1度だけ行い、以後の変更は `setBotFilter` / `setPatterns` 経由でストアと LocalStorage の両方へ書き込む。
 *
 * 受信した発言への適用(除外)は `chat-connection.ts` が担う(依存方向は chat-connection → bot-filter)。
 */
import { create } from "zustand";
import {
  type BotFilterConfig,
  isExcludedFromChat,
  loadBotFilterConfig,
  saveBotFilterConfig,
} from "@/lib/bot-filter";

interface BotFilterState {
  /** 除外するユーザー名パターン(`*` ワイルドカード可、小文字) */
  patterns: readonly string[];
  /** 接続中チャンネルの配信者自身の発言も除外するか */
  excludeBroadcaster: boolean;
  /** LocalStorage からの復元が済んでいるか */
  hydrated: boolean;
  /** 復元時に保存データが壊れていて、デフォルトに戻したか(設定画面で利用者に伝える) */
  wasCorrupted: boolean;
  /** bot除外設定(パターン + 配信者除外)をまとめて更新し、LocalStorage にも保存する */
  setBotFilter: (config: BotFilterConfig) => void;
  /** 配信者除外の設定は変えずに、パターンだけを更新する(`setBotFilter` の簡易版) */
  setPatterns: (patterns: readonly string[]) => void;
}

export const useBotFilterStore = create<BotFilterState>((set, get) => ({
  patterns: [],
  excludeBroadcaster: false,
  hydrated: false,
  wasCorrupted: false,
  setBotFilter: (config) => {
    saveBotFilterConfig(config);
    // 保存に成功した時点で LocalStorage は正常な値になっているため、壊れていた印は下ろす。
    // ストアが正本の値を持った状態になるので、復元済み扱いにする
    set({
      patterns: config.patterns,
      excludeBroadcaster: config.excludeBroadcaster,
      wasCorrupted: false,
      hydrated: true,
    });
  },
  setPatterns: (patterns) => {
    get().setBotFilter({ patterns, excludeBroadcaster: get().excludeBroadcaster });
  },
}));

/** LocalStorage からbot除外設定を復元する。既に復元済みなら何もしない(ブラウザ環境でのみ呼ぶこと) */
export function hydrateBotFilterStore(): void {
  if (useBotFilterStore.getState().hydrated) return;
  const { config, wasCorrupted } = loadBotFilterConfig();
  useBotFilterStore.setState({
    patterns: config.patterns,
    excludeBroadcaster: config.excludeBroadcaster,
    wasCorrupted,
    hydrated: true,
  });
}

/**
 * ユーザー名を現在のbot除外設定で除外すべきか。未復元なら先に復元する。
 * `channel` は接続中チャンネル名(= 配信者のログイン名。未接続なら null)で、配信者除外の判定に使う。
 */
export function isExcludedByBotFilter(username: string, channel: string | null): boolean {
  hydrateBotFilterStore();
  const { patterns, excludeBroadcaster } = useBotFilterStore.getState();
  return isExcludedFromChat(username, channel, { patterns, excludeBroadcaster });
}

/** テスト専用: ストアを初期状態(未復元)に戻す。各テストの beforeEach で呼び出すこと */
export function resetBotFilterStoreForTests(): void {
  useBotFilterStore.setState({ patterns: [], excludeBroadcaster: false, hydrated: false, wasCorrupted: false });
}
