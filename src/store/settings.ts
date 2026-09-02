/**
 * 言語設定(学ぶ言語 `learningLangs` / 解説言語 `explainLang`)を保持する、モジュールスコープのストア。
 *
 * 設定の正本は LocalStorage(`lib/settings.ts`)だが、翻訳・Pick up のパイプラインの起動と
 * 設定ダイアログの表示で参照するため、Zustand ストアにキャッシュして参照する(`bot-filter.ts` と同じ構成)。
 *
 * SSR 中(Next.js のプリレンダリング)に LocalStorage へ触れないよう、ストアの初期値はデフォルト設定にしておき、
 * ブラウザ側で `hydrateSettingsStore()` を呼んだときに初めて復元する。復元は1度だけ行い、
 * 以後の変更は `setSettings` 経由でストアと LocalStorage の両方へ書き込む。
 *
 * 言語設定が変わると翻訳・Pick up のセッションプール(システムプロンプトに言語ペアを含む)を作り直す必要があるため、
 * ホーム画面はこのストアの `settings` を購読してパイプラインを再起動する(`auto-pipeline.ts` の `start` を参照)。
 */
import { create } from "zustand";
import { clearSettings, DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "@/lib/settings";
import { resetPromptApiDiagnosis } from "./prompt-api";

/** LLM プロバイダに関わる設定が変わったか(変わったら環境診断をやり直す必要がある) */
function isLlmConfigChanged(prev: Settings, next: Settings): boolean {
  return (
    prev.llmProvider !== next.llmProvider ||
    prev.openRouterApiKey !== next.openRouterApiKey ||
    prev.openRouterModel !== next.openRouterModel
  );
}

interface SettingsState {
  settings: Settings;
  /** LocalStorage からの復元が済んでいるか */
  hydrated: boolean;
  /** 復元時に保存データが壊れていて、デフォルトに戻したか(設定ダイアログで利用者に伝える) */
  wasCorrupted: boolean;
  /**
   * 設定を更新し、LocalStorage にも保存する。
   * 学ぶ言語が空などスキーマに反する値は `saveSettings` が例外を投げ、ストアは変更しない
   */
  setSettings: (settings: Settings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,
  wasCorrupted: false,
  setSettings: (settings) => {
    const prev = useSettingsStore.getState().settings;
    saveSettings(settings);
    // 保存に成功した時点で LocalStorage は正常な値になっているため、壊れていた印は下ろす。
    // ストアが正本の値を持った状態になるので、復元済み扱いにする
    set({ settings, wasCorrupted: false, hydrated: true });
    // LLM プロバイダの設定が変わったら、確定済みの診断状態を破棄して新しいプロバイダの条件で診断し直す
    if (isLlmConfigChanged(prev, settings)) resetPromptApiDiagnosis();
  },
}));

/** LocalStorage から設定を復元する。既に復元済みなら何もしない(ブラウザ環境でのみ呼ぶこと) */
export function hydrateSettingsStore(): void {
  if (useSettingsStore.getState().hydrated) return;
  const { settings, wasCorrupted } = loadSettings();
  useSettingsStore.setState({ settings, wasCorrupted, hydrated: true });
}

/** 保存されている設定を LocalStorage から削除し、ストアをデフォルト設定に戻す(ブラウザ環境でのみ呼ぶこと) */
export function clearSettingsStore(): void {
  clearSettings();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, wasCorrupted: false, hydrated: true });
}

/** テスト専用: ストアを初期状態(未復元)に戻す。各テストの beforeEach で呼び出すこと */
export function resetSettingsStoreForTests(): void {
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS, hydrated: false, wasCorrupted: false });
}
