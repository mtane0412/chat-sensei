/**
 * 学ぶ言語(targetLang)・解説言語(explainLang)の設定を LocalStorage に保存・復元するモジュール。
 *
 * chat-sensei はログイン不要・サーバー不要のクライアントサイド専用アプリのため、
 * 利用者の設定は LocalStorage のみに永続化する。保存データが壊れている・
 * スキーマに合わない場合は暗黙に補正せず、デフォルト設定へ戻したうえで
 * `wasCorrupted: true` を返し、呼び出し元(設定画面)が利用者に伝えられるようにする
 * (CLAUDE.md の Fail-Fast 方針に準拠)。
 */
import { z } from "zod";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./ai/prompts";

export const SETTINGS_STORAGE_KEY = "chat-sensei:settings";

export const settingsSchema = z
  .object({
    /** 学ぶ言語(Twitchチャットの原文言語) */
    targetLang: z.enum(SUPPORTED_LANGUAGES),
    /** 解説言語(AIが生成する解説の言語) */
    explainLang: z.enum(SUPPORTED_LANGUAGES),
  })
  .refine((data) => data.targetLang !== data.explainLang, {
    message: "学ぶ言語と解説言語には異なる言語を指定してください",
    path: ["explainLang"],
  });

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = { targetLang: "en", explainLang: "ja" };

/** 設定画面のセレクトボックスに表示する、各言語のネイティブ表記 */
export const LANGUAGE_DISPLAY_NAMES: Record<SupportedLanguage, string> = {
  en: "English",
  ja: "日本語",
  es: "Español",
  de: "Deutsch",
  fr: "Français",
};

export interface LoadSettingsResult {
  settings: Settings;
  /** 保存されていた値が壊れていた(JSON不正・スキーマ不一致)ため、デフォルトに戻した場合 true */
  wasCorrupted: boolean;
}

function ensureBrowserEnvironment(): void {
  if (typeof window === "undefined") {
    throw new Error("settings.ts の関数はブラウザ環境でのみ呼び出せます(SSR中に呼び出さないでください)");
  }
}

/** LocalStorage から設定を読み込む。無い場合・壊れている場合はデフォルト設定を返す */
export function loadSettings(): LoadSettingsResult {
  ensureBrowserEnvironment();

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) {
    return { settings: DEFAULT_SETTINGS, wasCorrupted: false };
  }

  try {
    const settings = settingsSchema.parse(JSON.parse(raw));
    return { settings, wasCorrupted: false };
  } catch {
    return { settings: DEFAULT_SETTINGS, wasCorrupted: true };
  }
}

/** 設定を LocalStorage に保存する。スキーマ(学ぶ言語≠解説言語 含む)に反する値は例外を投げて拒否する */
export function saveSettings(settings: Settings): void {
  ensureBrowserEnvironment();
  const validated = settingsSchema.parse(settings);
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
}
