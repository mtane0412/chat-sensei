/**
 * src/lib/settings.ts のテスト。
 *
 * 学ぶ言語(learningLangs: 1つ以上)・解説言語(explainLang)の設定を LocalStorage に
 * 保存・復元する処理を検証する。壊れたデータ・不正なスキーマの場合は
 * デフォルト設定に戻し、その旨を呼び出し元が判定できることを確認する
 * (CLAUDE.md の Fail-Fast 方針: 暗黙のフォールバックにせず、呼び出し元に理由を返す)。
 *
 * 学ぶ言語と解説言語が同じ組み合わせは禁止しない。同じ言語の発言は翻訳・Pick up をしない、という扱いを
 * パイプライン側(`auto-pipeline.ts`)で行うため、設定としては許容する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, clearSettings, loadSettings, saveSettings } from "./settings";

afterEach(() => {
  window.localStorage.clear();
});

describe("loadSettings", () => {
  it("保存されたデータが無い場合はデフォルト設定(学ぶ言語 = 英語のみ / 解説言語 = 日本語)を返す", () => {
    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: false });
    expect(DEFAULT_SETTINGS).toEqual({ learningLangs: ["en"], explainLang: "ja" });
  });

  it("保存された正常な設定(学ぶ言語が複数)を復元する", () => {
    saveSettings({ learningLangs: ["es", "en"], explainLang: "ja" });

    const result = loadSettings();

    expect(result).toEqual({ settings: { learningLangs: ["es", "en"], explainLang: "ja" }, wasCorrupted: false });
  });

  it("学ぶ言語に解説言語と同じ言語が含まれていても、そのまま復元する(同じ言語の発言はパイプライン側でスキップする)", () => {
    saveSettings({ learningLangs: ["en", "ja"], explainLang: "ja" });

    expect(loadSettings()).toEqual({
      settings: { learningLangs: ["en", "ja"], explainLang: "ja" },
      wasCorrupted: false,
    });
  });

  it("JSONとして壊れたデータの場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{ これはJSONではない");

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("対応言語以外の値が保存されている場合はデフォルトに戻す", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["xx"], explainLang: "ja" }));

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("学ぶ言語が空の場合はデフォルトに戻す", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: [], explainLang: "ja" }));

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("学ぶ言語に重複がある場合はデフォルトに戻す", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["en", "en"], explainLang: "ja" }));

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("旧形式(targetLang / explainLang の1対1ペア)の保存データは暗黙に変換せず、デフォルトに戻して壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ targetLang: "en", explainLang: "ja" }));

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });
});

describe("saveSettings", () => {
  it("学ぶ言語が空の設定は例外を投げて保存しない", () => {
    expect(() => saveSettings({ learningLangs: [], explainLang: "ja" })).toThrow();
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

describe("clearSettings", () => {
  it("保存されていた設定をLocalStorageから削除し、以後はデフォルト設定が読み込まれる", () => {
    saveSettings({ learningLangs: ["es"], explainLang: "ja" });

    clearSettings();

    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: false });
  });
});
