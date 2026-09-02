/**
 * src/store/settings.ts(言語設定のストア)のテスト。
 *
 * 設定の正本は LocalStorage(`lib/settings.ts`)だが、パイプラインの起動やダイアログの表示で
 * 参照するためモジュールスコープの Zustand ストアに保持する。SSR 中に LocalStorage へ触れないよう
 * 復元(hydrate)は明示的に呼ぶ設計とし、復元は1度だけ行われること・保存データが壊れていた場合は
 * デフォルトに戻したうえでその事実を公開すること・不正な設定(学ぶ言語と解説言語が同じなど)は保存を拒否することを検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "@/lib/settings";
import { ensurePromptApiDiagnosed, resetPromptApiStoreForTests, usePromptApiStore } from "./prompt-api";
import { clearSettingsStore, hydrateSettingsStore, resetSettingsStoreForTests, useSettingsStore } from "./settings";

beforeEach(() => {
  resetSettingsStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
  resetPromptApiStoreForTests();
});

/** 環境診断済み(unavailable)の状態を作る。プロバイダ変更で再診断が要ることの検証に使う */
async function settleDiagnosisAsUnavailable() {
  await ensurePromptApiDiagnosed(async () => {
    throw new Error("Prompt API が無い環境");
  });
  expect(usePromptApiStore.getState().status.status).toBe("unavailable");
}

describe("setSettings と LLM 診断状態", () => {
  it("LLM プロバイダの設定が変わったら、確定済みの診断状態を checking に戻す(新しいプロバイダで診断し直すため)", async () => {
    hydrateSettingsStore();
    await settleDiagnosisAsUnavailable();

    useSettingsStore.getState().setSettings({
      ...useSettingsStore.getState().settings,
      llmProvider: "openrouter",
      openRouterApiKey: "sk-or-v1-test-key-0123",
      openRouterModel: "anthropic/claude-sonnet-5",
    });

    expect(usePromptApiStore.getState().status).toEqual({ status: "checking" });
  });

  it("言語設定だけが変わった場合は、確定済みの診断状態を維持する(環境は変わらないため)", async () => {
    hydrateSettingsStore();
    await settleDiagnosisAsUnavailable();

    useSettingsStore.getState().setSettings({ ...useSettingsStore.getState().settings, learningLang: "es" });

    expect(usePromptApiStore.getState().status.status).toBe("unavailable");
  });
});

describe("hydrateSettingsStore", () => {
  it("LocalStorage に保存済みの言語設定をストアに復元する", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "es", explainLang: "en" }));

    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "es", explainLang: "en" });
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
    useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, learningLang: "de", explainLang: "ja" });
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "fr", explainLang: "ja" }));

    hydrateSettingsStore();

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "de", explainLang: "ja" });
  });
});

describe("useSettingsStore.setSettings", () => {
  it("設定をストアに反映し、LocalStorage にも保存する", () => {
    hydrateSettingsStore();

    useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, learningLang: "fr", explainLang: "en" });

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "fr", explainLang: "en" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      ...DEFAULT_SETTINGS,
      learningLang: "fr",
      explainLang: "en",
    });
  });

  it("学ぶ言語と解説言語が同じ場合は例外を投げ、ストアも LocalStorage も変更しない", () => {
    hydrateSettingsStore();

    expect(() => useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, learningLang: "ja", explainLang: "ja" })).toThrow(
      /must be different/,
    );

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("壊れていた保存データを正常な値で保存し直すと、wasCorrupted が false に戻る", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");
    hydrateSettingsStore();

    useSettingsStore.getState().setSettings({ ...DEFAULT_SETTINGS, learningLang: "en", explainLang: "es" });

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
