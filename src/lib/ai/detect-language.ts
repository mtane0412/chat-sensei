/**
 * Language Detector API(Chrome 内蔵)で発言の言語を判定し、言語設定に照らして
 * 「学ぶ言語として翻訳・Pick up する / 解説言語と同じ(逆方向翻訳 + Pick up の対象)/ どちらでもないので何もしない」に
 * 振り分けるモジュール。
 *
 * 学ぶ言語と解説言語は 1:1 のペアで設定する(`lib/settings.ts`)。解説言語と同じ言語の発言
 * (日本語話者にとっての日本語チャットなど)は、パイプライン側が学ぶ言語への逆方向翻訳と
 * その訳文からの Pick up に回すため、ここでは「同じ言語」として振り分けだけを行う。
 *
 * 判定は Language Detector の最上位候補で決めるのが基本。ただし "oooohhh ok" のような短い感嘆詞は
 * 最上位候補が無関係な言語(ar など)になることがある(実配信で観測)ため、最上位候補が学ぶ言語にも
 * 解説言語にも該当しないときだけ、候補列(信頼度順)の中に `MIN_FALLBACK_CONFIDENCE` 以上の学ぶ言語・解説言語が
 * あれば先に見つかったものを採用する(漢字だけ・半角カナだけの日本語が zh と判定される誤判定にも対応する)。「不明なら先頭の学ぶ言語で扱う」のような判定器の結果に基づかない暗黙のフォールバックは行わず
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
 * 最上位候補が対象外だったとき、候補列の中の学ぶ言語・解説言語を採用するために必要な最低信頼度。
 * Chrome 152 での実測: 対象外言語の発言に混ざる学ぶ言語・解説言語は「牛逼」ja 0.022、「muito bom」en 0.006、
 * 「hallo alles goed」en 0.048 と 0.05 未満に収まり、拾いたい短文は「oooohhh ok」en 0.074、「ez」en 0.158、
 * 「草」ja 0.171、「人気投票」ja 0.262 と 0.05 以上に出る。その境界として 0.05 を採る
 */
export const MIN_FALLBACK_CONFIDENCE = 0.05;

/** ひらがな(U+3040–309F)・カタカナ(U+30A0–30FF)・半角カタカナ(U+FF66–FF9F)のいずれか */
const KANA_PATTERN = /[\u3040-\u30ff\uff66-\uff9f]/;

/** 本文にかなが含まれるか。含まれていれば判定器の結果によらず日本語とみなす */
export function containsKana(text: string): boolean {
  return KANA_PATTERN.test(text);
}

/** 漢字(CJK 統合漢字) */
const HAN_PATTERN = /\p{Script=Han}/u;

/**
 * 短い Latin 文字列の規則を適用する本文の最大長(文字数)。
 * 実測で拾いたい "KEKW" "sheesh" "oooohhh ok"(4〜10 文字)を含み、判定器を信頼したい "hallo alles goed"(16 文字)を含まない値
 */
export const SHORT_LATIN_TEXT_MAX_LENGTH = 12;

/** Latin 文字と空白・数字・一般的な記号だけで構成されているか(他の文字体系を 1 文字でも含めば false) */
const LATIN_ONLY_PATTERN = /^[\p{Script=Latin}\p{N}\p{P}\p{S}\s]+$/u;

/** Prompt API 対応言語のうち Latin 文字で書く言語 */
const LATIN_SCRIPT_LANGUAGES: readonly SupportedLanguage[] = ["en", "es", "de", "fr"];

/** 短い Latin 文字列の規則で採用する言語。学ぶ言語が Latin 文字ならその言語、そうでなく解説言語が Latin 文字なら「同じ言語」 */
function resolveShortLatinText(text: string, settings: Settings): LanguageClassification | null {
  if (text.length > SHORT_LATIN_TEXT_MAX_LENGTH || !LATIN_ONLY_PATTERN.test(text)) return null;
  if (LATIN_SCRIPT_LANGUAGES.includes(settings.learningLang)) return { kind: "learning" };
  if (LATIN_SCRIPT_LANGUAGES.includes(settings.explainLang)) return { kind: "same-as-explanation" };
  return null;
}

/** 日本語が学ぶ言語か解説言語に設定されているか */
function isJapaneseConfigured(settings: Settings): boolean {
  return settings.explainLang === "ja" || settings.learningLang === "ja";
}

/**
 * 判定器の最上位候補と本文から、規則で上書きした言語を決める。
 * かなを含めば日本語、漢字を含み zh 判定で日本語が設定にあれば日本語、それ以外は最上位候補の主言語部分
 */
function resolveDetectedLanguage(text: string, top: string | undefined, settings: Settings): string {
  if (containsKana(text)) return "ja";
  const detected = top === undefined ? UNDETERMINED_LANGUAGE : primaryLanguageSubtag(top);
  if (detected === "zh" && HAN_PATTERN.test(text) && isJapaneseConfigured(settings)) return "ja";
  return detected;
}

export type LanguageClassification =
  /** 学ぶ言語。順方向(学ぶ言語→解説言語)のセッションプールで翻訳・Pick up する */
  | { kind: "learning" }
  /** 解説言語と同じ言語。逆方向(解説言語→学ぶ言語)のセッションプールで翻訳・Pick up する */
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

/** 学ぶ言語と一致するか(学ぶ言語と解説言語が同じペアはスキーマで禁止されている) */
function isLearningLanguage(lang: string, settings: Settings): lang is SupportedLanguage {
  return isSupportedLanguage(lang) && lang === settings.learningLang;
}

/**
 * 本文・Language Detector の判定結果(信頼度順)・言語設定から、発言の扱いを決める。
 * 本文はかな規則・漢字規則にだけ使い、それ以外は判定器の候補列で決める。
 * 最上位候補がどちらでもないときは、候補列を信頼度順に見て `MIN_FALLBACK_CONFIDENCE` 以上の学ぶ言語・解説言語の
 * うち先に見つかったものを採用し、無ければ最上位候補の言語を添えて「対象外」にする。
 */
export function classifyDetectedLanguage(
  text: string,
  candidates: readonly DetectedLanguageCandidate[],
  settings: Settings,
): LanguageClassification {
  const detected = resolveDetectedLanguage(text, candidates[0]?.detectedLanguage, settings);

  if (detected === settings.explainLang) return { kind: "same-as-explanation" };
  if (isLearningLanguage(detected, settings)) return { kind: "learning" };

  // 短い感嘆詞・漢字だけの発言などで最上位候補が無関係な言語になった場合の救済。
  // 候補は信頼度順なので、学ぶ言語・解説言語のうち先に見つかったものを採用する
  for (const candidate of candidates.slice(1)) {
    if (candidate.detectedLanguage === undefined || (candidate.confidence ?? 0) < MIN_FALLBACK_CONFIDENCE) continue;
    const lang = primaryLanguageSubtag(candidate.detectedLanguage);
    if (lang === settings.explainLang) return { kind: "same-as-explanation" };
    if (isLearningLanguage(lang, settings)) return { kind: "learning" };
  }
  return resolveShortLatinText(text, settings) ?? { kind: "other", detectedLanguage: detected };
}

/**
 * 実ブラウザの Language Detector セッションを生成する。
 * `window.LanguageDetector` は診断済み(availability.ts)である前提で呼び出す。
 * モデル未ダウンロード時の `create()` にはユーザー操作が必要なため、Prompt API と同様にウォームアップから呼ぶ。
 */
export function createBrowserLanguageDetector(): Promise<LanguageDetectorLike> {
  return LanguageDetector.create();
}
