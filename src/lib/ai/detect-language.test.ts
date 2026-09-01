/**
 * src/lib/ai/detect-language.ts(Language Detector の判定結果の振り分け)のテスト。
 *
 * 発言ごとの言語判定結果(信頼度順の候補一覧)と言語設定から、その発言を
 * 「学ぶ言語として翻訳・Pick up する」「解説言語と同じなので何もしない」「学ぶ言語ではないので何もしない」の
 * どれに振り分けるかを検証する。判定は最上位候補だけで決め、信頼度による暗黙のフォールバックは行わない。
 */
import { describe, expect, it } from "vitest";
import type { Settings } from "@/lib/settings";
import { classifyDetectedLanguage } from "./detect-language";

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
