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
import { DEFAULT_SETTINGS } from "@/lib/settings";
import type { Settings } from "@/lib/settings";
import { classifyDetectedLanguage, MIN_FALLBACK_CONFIDENCE, SHORT_LATIN_TEXT_MAX_LENGTH } from "./detect-language";

const 英語を学ぶ日本語話者の設定: Settings = { ...DEFAULT_SETTINGS, learningLangs: ["en"], explainLang: "ja" };
const 日英混在チャットの設定: Settings = { ...DEFAULT_SETTINGS, learningLangs: ["en", "ja"], explainLang: "ja" };

describe("classifyDetectedLanguage(かな規則)", () => {
  // Language Detector は「龍が如く感」を zh-Hant 0.939 / ja 0.058、「ｱｲﾑﾚﾃﾞｨ」を zh-Hans 0.871 / ja 0.052 と判定する(実測)。
  // ひらがな・カタカナは中国語・韓国語には現れないため、本文にかなが 1 文字でもあれば判定器の結果によらず日本語とみなす
  it("本文にひらがなが含まれていれば、判定器が zh と言っていても日本語として扱う(学ぶ言語が日本語なら処理する)", () => {
    const result = classifyDetectedLanguage(
      "龍が如く感",
      [{ detectedLanguage: "zh-Hant", confidence: 0.939 }, { detectedLanguage: "ja", confidence: 0.058 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["ja"], explainLang: "en" },
    );

    expect(result).toEqual({ kind: "learning", lang: "ja" });
  });

  it("本文に半角カタカナが含まれていれば日本語として扱う(解説言語が日本語なら「同じ言語」)", () => {
    const result = classifyDetectedLanguage(
      "ｱｲﾑﾚﾃﾞｨ",
      [{ detectedLanguage: "zh-Hans", confidence: 0.871 }, { detectedLanguage: "ja", confidence: 0.052 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("本文に全角カタカナ・ひらがなが含まれていれば、候補列に ja が無くても日本語として扱う", () => {
    const result = classifyDetectedLanguage(
      "おおすぎｗｗｗｗ",
      [{ detectedLanguage: "lt", confidence: 0.653 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("日本語が学ぶ言語にも解説言語にも無い設定では、かなを含む本文は「対象外(ja)」にする", () => {
    const result = classifyDetectedLanguage(
      "それな",
      [{ detectedLanguage: "ja", confidence: 0.999 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["en"], explainLang: "es" },
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "ja" });
  });

  it("漢字だけの本文はかな規則の対象外で、判定器の候補列で決める(実測: 人気投票 = zh-Hans 0.475 / ja 0.262)", () => {
    const result = classifyDetectedLanguage(
      "人気投票",
      [{ detectedLanguage: "zh-Hans", confidence: 0.475 }, { detectedLanguage: "ja", confidence: 0.262 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });
});

describe("classifyDetectedLanguage(漢字規則)", () => {
  // Language Detector は「太陽神」のような漢字だけの発言を zh と判定し、候補列の ja も救済しきい値に届かないことがある(実配信で観測)。
  // chat-sensei では中国語を学ぶ言語・解説言語に選べないため、漢字を含み zh と判定された発言は日本語が設定にあれば日本語とみなす
  it("漢字を含む本文が zh と判定され、日本語が学ぶ言語にあれば日本語として処理する", () => {
    const result = classifyDetectedLanguage(
      "太陽神",
      [{ detectedLanguage: "zh-Hans", confidence: 0.9 }, { detectedLanguage: "ja", confidence: 0.03 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["ja"], explainLang: "en" },
    );

    expect(result).toEqual({ kind: "learning", lang: "ja" });
  });

  it("漢字を含む本文が zh と判定され、日本語が解説言語なら「同じ言語」にする", () => {
    const result = classifyDetectedLanguage(
      "太陽神〜！！",
      [{ detectedLanguage: "zh-Hant", confidence: 0.95 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("日本語が学ぶ言語にも解説言語にも無い設定では、zh 判定をそのまま「対象外(zh)」にする", () => {
    const result = classifyDetectedLanguage(
      "太陽神",
      [{ detectedLanguage: "zh-Hans", confidence: 0.9 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["en"], explainLang: "es" },
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "zh" });
  });

  it("漢字を含まない本文の zh 判定には適用しない", () => {
    const result = classifyDetectedLanguage(
      "ㅋㅋㅋㅋ",
      [{ detectedLanguage: "zh-Hans", confidence: 0.9 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "zh" });
  });
});

describe("classifyDetectedLanguage(短い Latin 文字列の規則)", () => {
  // Language Detector は "KEKW" を ku 0.136 / jv 0.091 / ht 0.077 …、"W" を ar-Latn 0.553 / en 0.259 と判定する(実測)。
  // 短い Latin 文字列は判定器が当てにならず候補列に学ぶ言語が出ないこともあるため、学ぶ言語のうち Latin 文字の先頭言語で扱う
  it("Latin 文字だけの短い本文で判定器の候補に設定言語が無ければ、学ぶ言語のうち Latin 文字の先頭言語で処理する", () => {
    const result = classifyDetectedLanguage(
      "KEKW",
      [
        { detectedLanguage: "ku", confidence: 0.136 },
        { detectedLanguage: "jv", confidence: 0.091 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("学ぶ言語が複数のときは、設定の並び順で最初の Latin 文字の言語を使う", () => {
    const result = classifyDetectedLanguage(
      "sheesh",
      [{ detectedLanguage: "so", confidence: 0.6 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["ja", "es", "en"], explainLang: "de" },
    );

    expect(result).toEqual({ kind: "learning", lang: "es" });
  });

  it("学ぶ言語に Latin 文字の言語が無く、解説言語が Latin 文字なら「同じ言語」にする", () => {
    const result = classifyDetectedLanguage(
      "KEKW",
      [{ detectedLanguage: "ku", confidence: 0.136 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["ja"], explainLang: "en" },
    );

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("上限より長い Latin 文字列には適用せず「対象外」のままにする(実測: hallo alles goed = nl 0.809 / en 0.048)", () => {
    const text = "hallo alles goed";
    expect(text.length).toBeGreaterThan(SHORT_LATIN_TEXT_MAX_LENGTH);

    const result = classifyDetectedLanguage(
      text,
      [{ detectedLanguage: "nl", confidence: 0.809 }, { detectedLanguage: "en", confidence: 0.048 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "nl" });
  });

  it("Latin 文字以外(ハングルなど)を含む短い本文には適用しない", () => {
    const result = classifyDetectedLanguage(
      "ㅋㅋㅋㅋ",
      [{ detectedLanguage: "ko", confidence: 1 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "ko" });
  });

  it("候補列からの救済で決まる場合はそちらを優先する(実測: W = ar-Latn 0.553 / en 0.259)", () => {
    const result = classifyDetectedLanguage(
      "W",
      [{ detectedLanguage: "ar-Latn", confidence: 0.553 }, { detectedLanguage: "en", confidence: 0.259 }],
      { ...DEFAULT_SETTINGS, learningLangs: ["es", "en"], explainLang: "ja" },
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });
});

describe("classifyDetectedLanguage", () => {
  it("最上位候補が学ぶ言語なら、その言語で処理する", () => {
    const result = classifyDetectedLanguage(
      "a latin text longer than the short limit",
      [
        { detectedLanguage: "en", confidence: 0.9 },
        { detectedLanguage: "ja", confidence: 0.1 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("最上位候補が解説言語と同じなら、学ぶ言語に含まれていても「同じ言語」として処理しない", () => {
    const result = classifyDetectedLanguage("a latin text longer than the short limit", [{ detectedLanguage: "ja", confidence: 0.95 }], 日英混在チャットの設定);

    expect(result).toEqual({ kind: "same-as-explanation" });
  });

  it("最上位候補が学ぶ言語にも解説言語にも該当しなければ、判定した言語を添えて「対象外」にする", () => {
    const result = classifyDetectedLanguage("안녕하세요", [{ detectedLanguage: "ko", confidence: 0.8 }], 英語を学ぶ日本語話者の設定);

    expect(result).toEqual({ kind: "other", detectedLanguage: "ko" });
  });

  it("最上位候補が対象外でも、候補列に十分な信頼度の学ぶ言語があればその言語で処理する(実測: oooohhh ok = ar-Latn 0.620 / nl 0.094 / en 0.074)", () => {
    const result = classifyDetectedLanguage(
      "oooohhh ok",
      [
        { detectedLanguage: "ar-Latn", confidence: 0.62 },
        { detectedLanguage: "nl", confidence: 0.094 },
        { detectedLanguage: "en", confidence: 0.074 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("対象外の言語の発言に学ぶ言語がごく低い信頼度で混ざっていても採用しない(実測: hallo alles goed = nl 0.809 / en 0.048、olá tudo bem = pt 0.999)", () => {
    const オランダ語 = classifyDetectedLanguage(
      "hallo alles goed",
      [{ detectedLanguage: "nl", confidence: 0.809 }, { detectedLanguage: "en", confidence: 0.048 }],
      英語を学ぶ日本語話者の設定,
    );
    const ポルトガル語 = classifyDetectedLanguage(
      "olá tudo bem com vocês",
      [{ detectedLanguage: "pt", confidence: 0.999 }, { detectedLanguage: "en", confidence: 0.006 }],
      英語を学ぶ日本語話者の設定,
    );

    expect(オランダ語).toEqual({ kind: "other", detectedLanguage: "nl" });
    expect(ポルトガル語).toEqual({ kind: "other", detectedLanguage: "pt" });
  });

  it("候補列に複数の学ぶ言語があるときは、信頼度が高い(先に並ぶ)ほうを採用する", () => {
    const result = classifyDetectedLanguage(
      "a latin text longer than the short limit",
      [
        { detectedLanguage: "pt", confidence: 0.5 },
        { detectedLanguage: "es", confidence: 0.3 },
        { detectedLanguage: "en", confidence: 0.15 },
      ],
      { ...DEFAULT_SETTINGS, learningLangs: ["en", "es"], explainLang: "ja" },
    );

    expect(result).toEqual({ kind: "learning", lang: "es" });
  });

  it("候補列の学ぶ言語の信頼度が下限未満なら採用せず「対象外」のままにする(韓国語の発言などを誤って処理しないため)", () => {
    const result = classifyDetectedLanguage(
      "a latin text longer than the short limit",
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
      "a latin text longer than the short limit",
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
      "a latin text longer than the short limit",
      [
        { detectedLanguage: "ar", confidence: 0.5 },
        { detectedLanguage: "en", confidence: 0.3 },
        { detectedLanguage: "ja", confidence: 0.15 },
      ],
      英語を学ぶ日本語話者の設定,
    );
    const 解説言語が先 = classifyDetectedLanguage(
      "a latin text longer than the short limit",
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
      "a latin text longer than the short limit",
      [
        { detectedLanguage: "zh", confidence: 0.98 },
        { detectedLanguage: "ja", confidence: MIN_FALLBACK_CONFIDENCE - 0.01 },
      ],
      英語を学ぶ日本語話者の設定,
    );

    expect(result).toEqual({ kind: "other", detectedLanguage: "zh" });
  });

  it("地域付きの言語タグ(en-US など)は主言語部分で照合する", () => {
    const result = classifyDetectedLanguage("a latin text longer than the short limit", [{ detectedLanguage: "en-US", confidence: 0.8 }], 英語を学ぶ日本語話者の設定);

    expect(result).toEqual({ kind: "learning", lang: "en" });
  });

  it("候補が空の場合は言語不明(und)として「対象外」にする", () => {
    expect(classifyDetectedLanguage("안녕하세요", [], 英語を学ぶ日本語話者の設定)).toEqual({ kind: "other", detectedLanguage: "und" });
  });

  it("最上位候補に言語が無い場合も言語不明(und)として「対象外」にする", () => {
    expect(classifyDetectedLanguage("안녕하세요", [{ confidence: 0.5 }], 英語を学ぶ日本語話者の設定)).toEqual({
      kind: "other",
      detectedLanguage: "und",
    });
  });
});
