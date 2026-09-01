/**
 * src/store/settings.ts(言語設定のストア)のテスト。
 *
 * 設定の正本は LocalStorage(`lib/settings.ts`)だが、パイプラインの起動やダイアログの表示で
 * 参照するためモジュールスコープの Zustand ストアに保持する。SSR 中に LocalStorage へ触れないよう
 * 復元(hydrate)は明示的に呼ぶ設計とし、復元は1度だけ行われること・保存データが壊れていた場合は
 * デフォルトに戻したうえでその事実を公開すること・不正な設定(学ぶ言語が空など)は保存を拒否することを検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "@/lib/settings";
import { clearSettingsStore, hydrateSettingsStore, resetSettingsStoreForTests, useSettingsStore } from "./settings";

beforeEach(() => {
  resetSettingsStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("hydrateSettingsStore", () => {
  it("LocalStorage に保存済みの言語設定をストアに復元する", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["es"], explainLang: "en" }));

    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["es"], explainLang: "en" });
    expect(useSettingsStore.getState().hydrated).toBe(true);
    expect(useSettingsStore.getState().wasCorrupted).toBe(false);
  });

  it("保存データが無ければデフォルト設定(学ぶ言語 = 英語のみ / 解説言語 = 日本語)になる", () => {
    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().hydrated).toBe(true);
  });

  it("保存データが壊れていればデフォルトに戻し、wasCorrupted を true にする", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");

    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().wasCorrupted).toBe(true);
  });

  it("2回目以降の呼び出しでは、ストア上の変更を LocalStorage の値で上書きしない", () => {
    hydrateSettingsStore();
    useSettingsStore.getState().setSettings({ learningLangs: ["de"], explainLang: "ja" });
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["fr"], explainLang: "ja" }));

    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["de"], explainLang: "ja" });
  });
});

describe("useSettingsStore.setSettings", () => {
  it("設定をストアに反映し、LocalStorage にも保存する", () => {
    hydrateSettingsStore();

    useSettingsStore.getState().setSettings({ learningLangs: ["fr", "ja"], explainLang: "en" });

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["fr", "ja"], explainLang: "en" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      learningLangs: ["fr", "ja"],
      explainLang: "en",
    });
  });

  it("学ぶ言語が空の場合は例外を投げ、ストアも LocalStorage も変更しない", () => {
    hydrateSettingsStore();

    expect(() => useSettingsStore.getState().setSettings({ learningLangs: [], explainLang: "ja" })).toThrow(
      /at least one/,
    );

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("壊れていた保存データを正常な値で保存し直すと、wasCorrupted が false に戻る", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");
    hydrateSettingsStore();

    useSettingsStore.getState().setSettings({ learningLangs: ["en"], explainLang: "es" });

    expect(useSettingsStore.getState().wasCorrupted).toBe(false);
  });
});

describe("clearSettingsStore", () => {
  it("LocalStorage の設定を削除し、ストアをデフォルト設定に戻す", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");
    hydrateSettingsStore();

    clearSettingsStore();

    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(useSettingsStore.getState().wasCorrupted).toBe(false);
    expect(useSettingsStore.getState().hydrated).toBe(true);
  });
});
