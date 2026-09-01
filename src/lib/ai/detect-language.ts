/**
 * Language Detector API(Chrome 内蔵)で発言の言語を判定し、言語設定に照らして
 * 「学ぶ言語として翻訳・Pick up する / 解説言語と同じなので何もしない / 学ぶ言語ではないので何もしない」に
 * 振り分けるモジュール。
 *
 * 配信によっては英語と日本語のように複数の言語のチャットが混ざるため、学ぶ言語は複数選べる。
 * 解説言語と同じ言語の発言(日本語話者にとっての日本語チャットなど)は訳す意味も解説する意味も無いので、
 * 設定で禁止する代わりにここで判定してスキップする。
 *
 * 判定は Language Detector の最上位候補で決めるのが基本。ただし "oooohhh ok" のような短い感嘆詞は
 * 最上位候補が無関係な言語(ar など)になることがある(実配信で観測)ため、最上位候補が学ぶ言語にも
 * 解説言語にも該当しないときだけ、候補列(信頼度順)の中に `MIN_FALLBACK_CONFIDENCE` 以上の学ぶ言語があれば
 * それを採用する。「不明なら先頭の学ぶ言語で扱う」のような判定器の結果に基づかない暗黙のフォールバックは行わず
 * (CLAUDE.md の Fail-Fast 方針)、該当しなければ判定した言語を添えて「対象外」として利用者に見せる。
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

/**
 * 最上位候補が対象外だったとき、候補列の中の学ぶ言語を採用するために必要な最低信頼度。
 * 韓国語の発言などでは学ぶ言語の候補がこれより低い値にしかならず、短い英語の感嘆詞では
 * 2 位以下でもこれを超える(実測: "oooohhh ok" で ar 0.45 / en 0.3 程度)ことを踏まえた値
 */
export const MIN_FALLBACK_CONFIDENCE = 0.1;

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

/** 解説言語を除いた、処理対象になる学ぶ言語かどうか */
function isProcessableLearningLanguage(lang: string, settings: Settings): lang is SupportedLanguage {
  return isSupportedLanguage(lang) && lang !== settings.explainLang && settings.learningLangs.includes(lang);
}

/**
 * Language Detector の判定結果(信頼度順)と言語設定から、発言の扱いを決める。
 * 解説言語との一致を学ぶ言語より先に判定するため、学ぶ言語に解説言語が含まれていても「同じ言語」になる。
 * 最上位候補がどちらでもないときは、候補列に `MIN_FALLBACK_CONFIDENCE` 以上の学ぶ言語があればそれを採用し、
 * 無ければ最上位候補の言語を添えて「対象外」にする。
 */
export function classifyDetectedLanguage(
  candidates: readonly DetectedLanguageCandidate[],
  settings: Settings,
): LanguageClassification {
  const top = candidates[0]?.detectedLanguage;
  const detected = top === undefined ? UNDETERMINED_LANGUAGE : primaryLanguageSubtag(top);

  if (detected === settings.explainLang) return { kind: "same-as-explanation" };
  if (isProcessableLearningLanguage(detected, settings)) return { kind: "learning", lang: detected };

  // 短い感嘆詞などで最上位候補が無関係な言語になった場合の救済。候補は信頼度順なので、先に見つかったものを採用する
  for (const candidate of candidates.slice(1)) {
    if (candidate.detectedLanguage === undefined || (candidate.confidence ?? 0) < MIN_FALLBACK_CONFIDENCE) continue;
    const lang = primaryLanguageSubtag(candidate.detectedLanguage);
    if (isProcessableLearningLanguage(lang, settings)) return { kind: "learning", lang };
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
