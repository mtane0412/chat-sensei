/**
 * src/lib/settings.ts のテスト。
 *
 * 学ぶ言語(learningLang: 1つ)・解説言語(explainLang)の設定を LocalStorage に
 * 保存・復元する処理を検証する。壊れたデータ・不正なスキーマの場合は
 * デフォルト設定に戻し、その旨を呼び出し元が判定できることを確認する
 * (CLAUDE.md の Fail-Fast 方針: 暗黙のフォールバックにせず、呼び出し元に理由を返す)。
 *
 * 学ぶ言語と解説言語が同じ組み合わせは禁止する。解説言語と同じ言語の発言は
 * 「学ぶ言語への逆方向翻訳 + その訳文からの Pick up」の対象になるため、
 * 同じ言語のペアでは処理の意味が無くなるため(逆方向翻訳が恒等写像になる)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, clearSettings, loadSettings, saveSettings } from "./settings";

afterEach(() => {
  window.localStorage.clear();
});

describe("loadSettings", () => {
  it("保存されたデータが無い場合はデフォルト設定(学ぶ言語 = 英語 / 解説言語 = 日本語)を返す", () => {
    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: false });
    expect(DEFAULT_SETTINGS).toEqual({
      learningLang: "en",
      explainLang: "ja",
      llmProvider: "gemini-nano",
      openRouterApiKey: "",
      openRouterModel: "",
    });
  });

  it("保存された正常な設定(スペイン語を英語で学ぶ)を復元する", () => {
    saveSettings({ ...DEFAULT_SETTINGS, learningLang: "es", explainLang: "en" });

    const result = loadSettings();

    expect(result).toEqual({
      settings: { ...DEFAULT_SETTINGS, learningLang: "es", explainLang: "en" },
      wasCorrupted: false,
    });
  });

  it("学ぶ言語と解説言語が同じ設定が保存されている場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "ja", explainLang: "ja" }));

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("JSONとして壊れたデータの場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{ これはJSONではない");

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("対応言語以外の値が保存されている場合はデフォルトに戻す", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "xx", explainLang: "ja" }));

    const result = loadSettings();

    expect(result).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });

  it("旧形式(learningLangs の配列)の保存データは、先頭の学ぶ言語を learningLang として移行する(LLM プロバイダ設定を巻き添えで消さない)", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        learningLangs: ["fr"],
        explainLang: "en",
        llmProvider: "openrouter",
        openRouterApiKey: "sk-or-v1-テスト用キー",
        openRouterModel: "anthropic/claude-sonnet-5",
      }),
    );

    expect(loadSettings()).toEqual({
      settings: {
        learningLang: "fr",
        explainLang: "en",
        llmProvider: "openrouter",
        openRouterApiKey: "sk-or-v1-テスト用キー",
        openRouterModel: "anthropic/claude-sonnet-5",
      },
      wasCorrupted: false,
    });
  });

  it("旧形式の学ぶ言語に解説言語が含まれる場合は、解説言語と異なる最初の言語を採用する(同じペアはスキーマで禁止のため)", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["ja", "en"], explainLang: "ja" }));

    expect(loadSettings()).toEqual({
      settings: { ...DEFAULT_SETTINGS, learningLang: "en", explainLang: "ja" },
      wasCorrupted: false,
    });
  });

  it("旧形式の学ぶ言語が解説言語だけの場合は移行できないため、デフォルトに戻して壊れていたことを伝える", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["ja"], explainLang: "ja" }));

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });
});

describe("saveSettings", () => {
  it("学ぶ言語と解説言語が同じ設定は例外を投げて保存しない", () => {
    expect(() => saveSettings({ ...DEFAULT_SETTINGS, learningLang: "ja", explainLang: "ja" })).toThrow(
      /must be different/,
    );
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });
});

describe("LLMプロバイダ設定", () => {
  it("旧形式(llmProvider 無し)の保存データは Gemini Nano・空の OpenRouter 設定として復元する(壊れた扱いにしない)", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "en", explainLang: "ja" }));

    expect(loadSettings()).toEqual({
      settings: {
        learningLang: "en",
        explainLang: "ja",
        llmProvider: "gemini-nano",
        openRouterApiKey: "",
        openRouterModel: "",
      },
      wasCorrupted: false,
    });
  });

  it("OpenRouter プロバイダの設定(APIキー・モデル)を保存・復元できる", () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: "openrouter" as const,
      openRouterApiKey: "sk-or-v1-テスト用キー",
      openRouterModel: "anthropic/claude-sonnet-5",
    };
    saveSettings(settings);

    expect(loadSettings()).toEqual({ settings, wasCorrupted: false });
  });

  it("OpenRouter プロバイダなのに API キーが空の設定は例外を投げて保存しない", () => {
    expect(() =>
      saveSettings({ ...DEFAULT_SETTINGS, llmProvider: "openrouter", openRouterModel: "anthropic/claude-sonnet-5" }),
    ).toThrow();
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("OpenRouter プロバイダなのにモデルが空の設定は例外を投げて保存しない", () => {
    expect(() =>
      saveSettings({ ...DEFAULT_SETTINGS, llmProvider: "openrouter", openRouterApiKey: "sk-or-v1-テスト用キー" }),
    ).toThrow();
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("Gemini Nano プロバイダでは API キー・モデルが空でも保存できる", () => {
    saveSettings({ ...DEFAULT_SETTINGS, llmProvider: "gemini-nano" });

    expect(loadSettings().wasCorrupted).toBe(false);
  });

  it("未知のプロバイダ名が保存されている場合はデフォルトに戻す", () => {
    window.localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ learningLang: "en", explainLang: "ja", llmProvider: "unknown-provider" }),
    );

    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: true });
  });
});

describe("clearSettings", () => {
  it("保存されていた設定をLocalStorageから削除し、以後はデフォルト設定が読み込まれる", () => {
    saveSettings({ ...DEFAULT_SETTINGS, learningLang: "es" });

    clearSettings();

    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(loadSettings()).toEqual({ settings: DEFAULT_SETTINGS, wasCorrupted: false });
  });
});
