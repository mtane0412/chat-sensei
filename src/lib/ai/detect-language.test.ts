/**
 * src/lib/ai/detect-language.ts(Language Detector の判定結果の振り分け)のテスト。
 *
 * 発言ごとの言語判定結果(信頼度順の候補一覧)と言語設定から、その発言を
 * 「学ぶ言語として翻訳・Pick up する」「解説言語と同じなので何もしない」「学ぶ言語ではないので何もしない」の
 * どれに振り分けるかを検証する。
 *
 * 判定は最上位候補で決めるのが基本だが、"oooohhh ok" のような短い感嘆詞は最上位候補が
 * 無関係な言語(ar など)になることがある(実配信で観測)。そのため最上位候補が学ぶ言語にも
 * 解説言語にも該当しないときだけ、候補列(信頼度順)の中に十分な信頼度の学ぶ言語・解説言語があれば
 * 先に見つかったものを採用する(漢字だけ・半角カナだけの日本語が zh になる誤判定にも対応する)。
 * 「先頭の学ぶ言語で扱う」ような判定器の結果に基づかないフォールバックは行わない。
 */
import { describe, expect, it } from "vitest";
import type { Settings } from "@/lib/settings";
import { classifyDetectedLanguage, MIN_FALLBACK_CONFIDENCE } from "./detect-language";

const 英語を学ぶ日本語話者の設定: Settings = { learningLangs: ["en"], explainLang: "ja" };
const 日英混在チャットの設定: Settings = { learningLangs: ["en", "ja"], explainLang: "ja" };

describe("classifyDetectedLanguage", () => {
  it("最上位候補が学ぶ言語なら、その言語で処理する", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "en", confidence: 0.9 },
        { detectedLanguage: "ja", confidence: 0.1 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("最上位候補が解説言語と同じなら、学ぶ言語に含まれていても「同じ言語」として処理しない", () => {
    const result = classifyDetectedLanguage([{ detectedLanguage: "ja", confidence: 0.95 }], 日英混在チャットの設定);

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("最上位候補が学ぶ言語にも解説言語にも該当しなければ、判定した言語を添えて「対象外」にする", () => {
    const result = classifyDetectedLanguage([{ detectedLanguage: "ko", confidence: 0.8 }], 英語を学ぶ日本語話者の設定);

    expect(result).toEqual({ kind: "other", detectedLanguage: "ko" });
  });

  it("最上位候補が対象外でも、候補列に十分な信頼度の学ぶ言語があればその言語で処理する(短い感嘆詞の誤判定対策)", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "ar", confidence: 0.45 },
        { detectedLanguage: "en", confidence: 0.3 },
        { detectedLanguage: "ja", confidence: 0.05 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("候補列に複数の学ぶ言語があるときは、信頼度が高い(先に並ぶ)ほうを採用する", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "pt", confidence: 0.5 },
        { detectedLanguage: "es", confidence: 0.3 },
        { detectedLanguage: "en", confidence: 0.15 },
      ],
      { learningLangs: ["en", "es"], explainLang: "ja" },
    );

    expect(result).toEqual({ kind: "learning", lang: "es" });
  });

  it("候補列の学ぶ言語の信頼度が下限未満なら採用せず「対象外」のままにする(韓国語の発言などを誤って処理しないため)", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "ko", confidence: 0.98 },
        { detectedLanguage: "en", confidence: MIN_FALLBACK_CONFIDENCE - 0.01 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "ko" });
  });

  it("最上位候補が対象外でも、候補列に十分な信頼度の解説言語があれば「同じ言語」にする(漢字だけ・半角カナだけの日本語が zh になる誤判定対策)", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "zh", confidence: 0.6 },
        { detectedLanguage: "ja", confidence: 0.35 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("候補列に学ぶ言語と解説言語の両方があるときは、信頼度が高い(先に並ぶ)ほうを採用する", () => {
    const 学ぶ言語が先 = classifyDetectedLanguage(
      [
        { detectedLanguage: "ar", confidence: 0.5 },
        { detectedLanguage: "en", confidence: 0.3 },
        { detectedLanguage: "ja", confidence: 0.15 },
      ],
      英語を学ぶ日本語話者の設定,
    );
    const 解説言語が先 = classifyDetectedLanguage(
      [
        { detectedLanguage: "ar", confidence: 0.5 },
        { detectedLanguage: "ja", confidence: 0.3 },
        { detectedLanguage: "en", confidence: 0.15 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(学ぶ言語が先).toEqual({ kind: "learning", lang: "en" });
    expect(解説言語が先).toEqual({ kind: "same-as-explanation" });
  });

  it("候補列の解説言語の信頼度が下限未満なら「同じ言語」にはせず「対象外」のままにする", () => {
    const result = classifyDetectedLanguage(
      [
        { detectedLanguage: "zh", confidence: 0.98 },
        { detectedLanguage: "ja", confidence: MIN_FALLBACK_CONFIDENCE - 0.01 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "zh" });
  });

  it("地域付きの言語タグ(en-US など)は主言語部分で照合する", () => {
    const result = classifyDetectedLanguage([{ detectedLanguage: "en-US", confidence: 0.8 }], 英語を学ぶ日本語話者の設定);

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("候補が空の場合は言語不明(und)として「対象外」にする", () => {
    expect(classifyDetectedLanguage([], 英語を学ぶ日本語話者の設定)).toEqual({ kind: "other", detectedLanguage: "und" });
  });

  it("最上位候補に言語が無い場合も言語不明(und)として「対象外」にする", () => {
    expect(classifyDetectedLanguage([{ confidence: 0.5 }], 英語を学ぶ日本語話者の設定)).toEqual({
      kind: "other",
      detectedLanguage: "und",
    });
  });
});
