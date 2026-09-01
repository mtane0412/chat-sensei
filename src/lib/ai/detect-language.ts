/**
 * Language Detector API(Chrome 内蔵)で発言の言語を判定し、言語設定に照らして
 * 「学ぶ言語として翻訳・Pick up する / 解説言語と同じなので何もしない / 学ぶ言語ではないので何もしない」に
 * 振り分けるモジュール。
 *
 * 配信によっては英語と日本語のように複数の言語のチャットが混ざるため、学ぶ言語は複数選べる。
 * 解説言語と同じ言語の発言(日本語話者にとっての日本語チャットなど)は訳す意味も解説する意味も無いので、
 * 設定で禁止する代わりにここで判定してスキップする。
 *
 * 判定は Language Detector の最上位候補だけで決める。信頼度のしきい値による「不明なら先頭の学ぶ言語で扱う」
 * といった暗黙のフォールバックは行わず(CLAUDE.md の Fail-Fast 方針)、該当しなければ判定した言語を添えて
 * 「対象外」として利用者に見せる。
 *
 * - `classifyDetectedLanguage`: 判定結果の振り分け(純関数)
 * - `createBrowserLanguageDetector`: 実ブラウザの `LanguageDetector.create()` を呼ぶ生成関数
 */
import type { Settings } from "@/lib/settings";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./prompts";

/** Language Detector の 1 候補。`@types/dom-chromium-ai` の `LanguageDetectionResult` と同じ形 */
export interface DetectedLanguageCandidate {
  detectedLanguage?: string;
  confidence?: number;
}

/** Language Detector のセッションが最低限備えるべきインターフェース */
export interface LanguageDetectorLike {
  detect(input: string): Promise<DetectedLanguageCandidate[]>;
}

/** 言語が判定できなかったときの BCP 47 タグ(Language Detector も同じ値を返す) */
export const UNDETERMINED_LANGUAGE = "und";

export type LanguageClassification =
  /** 学ぶ言語のひとつ。`lang` のセッションプールで翻訳・Pick up する */
  | { kind: "learning"; lang: SupportedLanguage }
  /** 解説言語と同じ言語。翻訳・Pick up をしない */
  | { kind: "same-as-explanation" }
  /** 学ぶ言語にも解説言語にも該当しない(未判定 `und` を含む)。翻訳・Pick up をしない */
  | { kind: "other"; detectedLanguage: string };

/** BCP 47 タグ(`en-US` など)の主言語部分を小文字で返す */
function primaryLanguageSubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

function isSupportedLanguage(value: string): value is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/**
 * Language Detector の判定結果(信頼度順)と言語設定から、発言の扱いを決める。
 * 解説言語との一致を学ぶ言語より先に判定するため、学ぶ言語に解説言語が含まれていても「同じ言語」になる。
 */
export function classifyDetectedLanguage(
  candidates: readonly DetectedLanguageCandidate[],
  settings: Settings,
): LanguageClassification {
  const top = candidates[0]?.detectedLanguage;
  const detected = top === undefined ? UNDETERMINED_LANGUAGE : primaryLanguageSubtag(top);

  if (detected === settings.explainLang) return { kind: "same-as-explanation" };
  if (isSupportedLanguage(detected) && settings.learningLangs.includes(detected)) {
    return { kind: "learning", lang: detected };
  }
  return { kind: "other", detectedLanguage: detected };
}

/**
 * 実ブラウザの Language Detector セッションを生成する。
 * `window.LanguageDetector` は診断済み(availability.ts)である前提で呼び出す。
 * モデル未ダウンロード時の `create()` にはユーザー操作が必要なため、Prompt API と同様にウォームアップから呼ぶ。
 */
export function createBrowserLanguageDetector(): Promise<LanguageDetectorLike> {
  return LanguageDetector.create();
}
