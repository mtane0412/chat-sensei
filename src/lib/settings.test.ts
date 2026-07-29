/**
 * src/lib/settings.ts のテスト。
 *
 * 学ぶ言語(targetLang)・解説言語(explainLang)の設定を LocalStorage に
 * 保存・復元する処理を検証する。壊れたデータ・不正なスキーマの場合は
 * デフォルト設定に戻し、その旨を呼び出し元が判定できることを確認する
 * (CLAUDE.md の Fail-Fast 方針: 暗黙のフォールバックにせず、呼び出し元に理由を返す)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, loadSettings, saveSettings } from "./settings";

afterEach(() => {
  window.localStorage.clear();
});

describe("loadSettings", () => {
  it("保存されたデータが無い場合はデフォルト設定を返す", () => {
    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: false });
  });

  it("保存された正常な設定を復元する", () => {
    saveSettings({ targetLang: "es", explainLang: "ja" });

    const result = loadSettings();

    expect(result).toEqual({ settings: { targetLang: "es", explainLang: "ja" }, wasCorrupted: false });
  });

  it("JSONとして壊れたデータの場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{ これはJSONではない");

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("対応言語以外の値が保存されている場合はデフォルトに戻す", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ targetLang: "xx", explainLang: "ja" }),
    );

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("学ぶ言語と解説言語が同じ値で保存されている場合はデフォルトに戻す", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ targetLang: "en", explainLang: "en" }),
    );

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });
});

describe("saveSettings", () => {
  it("学ぶ言語と解説言語が同じ場合は保存を拒否する(モジュール側でも二重に防止する)", () => {
    expect(() => saveSettings({ targetLang: "en", explainLang: "en" })).toThrow();
  });
});
