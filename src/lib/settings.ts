/**
 * 学ぶ言語(learningLang: 1つ)・解説言語(explainLang)・LLM プロバイダ
 * (llmProvider / openRouterApiKey / openRouterModel)の設定を LocalStorage に保存・復元するモジュール。
 *
 * 学ぶ言語と解説言語は 1:1 のペアで設定する。解説言語と同じ言語の発言は
 * 「学ぶ言語への逆方向翻訳 + その訳文からの Pick up」の対象になるため
 * (`store/auto-pipeline.ts`)、日英混在チャットのような複数言語の配信も 1:1 のままカバーできる。
 * 学ぶ言語と解説言語が同じペアは逆方向翻訳が恒等写像になり意味が無いため、スキーマで禁止する。
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

/** 翻訳・Pick up の生成に使う LLM プロバイダの選択肢 */
export const LLM_PROVIDERS = ["gemini-nano", "openrouter"] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const settingsSchema = z.object({
  /** 学ぶ言語(Twitchチャットの原文として翻訳・Pick up の対象にする言語) */
  learningLang: z.enum(SUPPORTED_LANGUAGES),
  /** 解説言語(訳文・Pick up の意味の言語) */
  explainLang: z.enum(SUPPORTED_LANGUAGES),
  /** 翻訳・Pick up の生成に使う LLM プロバイダ。旧形式(項目なし)の保存データは Gemini Nano として復元する */
  llmProvider: z.enum(LLM_PROVIDERS).default("gemini-nano"),
  /** OpenRouter の API キー。プロバイダが openrouter のときのみ必須 */
  openRouterApiKey: z.string().default(""),
  /** OpenRouter のモデル ID(例: "anthropic/claude-sonnet-5")。プロバイダが openrouter のときのみ必須 */
  openRouterModel: z.string().default(""),
}).superRefine((settings, ctx) => {
  // 学ぶ言語と解説言語が同じペアは、逆方向翻訳(解説言語→学ぶ言語)が意味を持たないため保存時点で拒否する(Fail-Fast)
  if (settings.learningLang === settings.explainLang) {
    ctx.addIssue({
      code: "custom",
      message: "Learning and explanation languages must be different",
      path: ["learningLang"],
    });
  }
  // OpenRouter を選んだのにキー・モデルが無い設定は動作しないため、保存時点で拒否する(Fail-Fast)
  if (settings.llmProvider !== "openrouter") return;
  if (settings.openRouterApiKey.trim() === "") {
    ctx.addIssue({ code: "custom", message: "Enter your OpenRouter API key", path: ["openRouterApiKey"] });
  }
  if (settings.openRouterModel.trim() === "") {
    ctx.addIssue({ code: "custom", message: "Select an OpenRouter model", path: ["openRouterModel"] });
  }
});

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  learningLang: "en",
  explainLang: "ja",
  llmProvider: "gemini-nano",
  openRouterApiKey: "",
  openRouterModel: "",
};

/** 設定画面のセレクトボックスに表示する、各 LLM プロバイダの表示名 */
export const LLM_PROVIDER_DISPLAY_NAMES: Record<LlmProvider, string> = {
  "gemini-nano": "Gemini Nano (on-device)",
  openrouter: "OpenRouter",
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

/**
 * 旧形式(learningLangs: 配列)の保存データを現行の 1:1 形式へ明示的に移行する。
 * 解説言語と異なる最初の学ぶ言語を learningLang に採用し、LLM プロバイダ設定(API キー等)の
 * 他項目は巻き添えで消さずに保持する。移行できない場合(learningLangs が解説言語だけ等)は
 * そのまま返し、後段のスキーマ検証で壊れた扱い(デフォルトへ戻す)にする。
 */
function migrateLegacySettings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const record = raw as Record<string, unknown>;
  if ("learningLang" in record || !Array.isArray(record.learningLangs)) return raw;
  const learningLang: unknown = record.learningLangs.find((lang) => lang !== record.explainLang);
  if (learningLang === undefined) return raw;
  const migrated: Record<string, unknown> = { ...record, learningLang };
  delete migrated.learningLangs;
  return migrated;
}

/** LocalStorage から設定を読み込む。無い場合・壊れている場合はデフォルト設定を返す */
export function loadSettings(): LoadSettingsResult {
  ensureBrowserEnvironment();

  const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) {
    return { settings: DEFAULT_SETTINGS, wasCorrupted: false };
  }

  try {
    const settings = settingsSchema.parse(migrateLegacySettings(JSON.parse(raw)));
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
