/**
 * 学ぶ言語(learningLangs: 1つ以上)・解説言語(explainLang)の設定を LocalStorage に保存・復元するモジュール。
 *
 * 学ぶ言語は配信ごとに複数の言語が混ざるチャット(英語と日本語など)に対応するため複数選べる。
 * 学ぶ言語と解説言語が同じ組み合わせは禁止しない。解説言語と同じ言語の発言は翻訳・Pick up をしない、
 * という扱いをパイプライン側(`store/auto-pipeline.ts`)が Language Detector の判定結果で行う。
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

export const settingsSchema = z.object({
  /** 学ぶ言語(Twitchチャットの原文として翻訳・Pick up の対象にする言語)。1つ以上、重複なし */
  learningLangs: z
    .array(z.enum(SUPPORTED_LANGUAGES))
    .min(1, "Select at least one learning language")
    .refine((langs) => new Set(langs).size === langs.length, { message: "Learning languages must not repeat" }),
  /** 解説言語(訳文・Pick up の意味の言語) */
  explainLang: z.enum(SUPPORTED_LANGUAGES),
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  learningLangs: ["en"],
  explainLang: "ja",
};

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

/** 設定を LocalStorage に保存する。スキーマ(学ぶ言語が空・重複など)に反する値は例外を投げて拒否する */
export function saveSettings(settings: Settings): void {
  ensureBrowserEnvironment();
  const validated = settingsSchema.parse(settings);
  window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(validated));
}

/** 保存されている設定を LocalStorage から削除する。以後 `loadSettings` はデフォルト設定を返す */
export function clearSettings(): void {
  ensureBrowserEnvironment();
  window.localStorage.removeItem(SETTINGS_STORAGE_KEY);
}
