/**
 * src/lib/ai/prompts.ts のテスト。
 *
 * 「学ぶ言語(targetLang)」と「解説言語(explainLang)」の組み合わせから、
 * Prompt API に渡すシステムプロンプト・ユーザープロンプトを組み立てる
 * 純関数を検証する。
 */
import { describe, expect, it } from "vitest";
import {
  buildExplainSystemPrompt,
  buildExplainUserPrompt,
  buildTriageUserPrompt,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
} from "./prompts";

describe("SUPPORTED_LANGUAGES", () => {
  it("Prompt APIが対応する5言語(en/ja/es/de/fr)を含む", () => {
    expect(SUPPORTED_LANGUAGES).toEqual(["en", "ja", "es", "de", "fr"]);
  });
});

describe("buildExplainSystemPrompt", () => {
  it("解説言語がjaのとき、日本語でシステムプロンプトを組み立てる", () => {
    const prompt = buildExplainSystemPrompt("en", "ja");

    expect(prompt).toContain("英語");
    expect(prompt).toContain("日本語");
  });

  it("解説言語がenのとき、英語でシステムプロンプトを組み立てる", () => {
    const prompt = buildExplainSystemPrompt("ja", "en");

    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("English");
  });

  it("学ぶ言語と解説言語の組み合わせを変えると、対応する言語名がプロンプトに反映される", () => {
    const prompt = buildExplainSystemPrompt("es", "fr");

    expect(prompt).toContain("espagnol");
    expect(prompt).toContain("français");
  });

  it("すべてのサポート言語の組み合わせでエラーなくプロンプトを生成できる", () => {
    for (const targetLang of SUPPORTED_LANGUAGES) {
      for (const explainLang of SUPPORTED_LANGUAGES) {
        if (targetLang === explainLang) continue;
        expect(() => buildExplainSystemPrompt(targetLang, explainLang)).not.toThrow();
      }
    }
  });

  it("解説言語がjaのとき、列挙する語句は元のチャット本文にそのまま登場する文字列に限る指示を含む(解説言語の単語混入を防ぐため)", () => {
    const prompt = buildExplainSystemPrompt("en", "ja");

    expect(prompt).toMatch(/そのまま登場する文字列/);
  });

  it("解説言語がjaのとき、代名詞・前置詞・数字・記号単体・@メンションを列挙しない指示を含む", () => {
    const prompt = buildExplainSystemPrompt("en", "ja");

    expect(prompt).toMatch(/代名詞/);
    expect(prompt).toMatch(/メンション/);
  });

  it("解説言語がenのとき、列挙する語句は元のチャット本文の厳密な部分文字列に限る指示を含む", () => {
    const prompt = buildExplainSystemPrompt("ja", "en");

    expect(prompt).toMatch(/exact substring/i);
    expect(prompt).toMatch(/mention/i);
  });

  it("すべてのサポート言語で、列挙する語句を原文の部分文字列に限定する指示(exact substring相当)を含む", () => {
    // 各言語の翻訳が正しいことまでは検証しないが、指示自体が漏れなく追加されていることを、
    // 「元のメッセージ」を指す語("original"に相当する各言語の単語)が含まれるかで確認する
    const ORIGINAL_MESSAGE_KEYWORDS: Record<SupportedLanguage, RegExp> = {
      en: /original/i,
      ja: /元の/,
      es: /original/i,
      de: /ursprünglichen/i,
      fr: /original/i,
    };

    for (const explainLang of SUPPORTED_LANGUAGES) {
      const targetLang = SUPPORTED_LANGUAGES.find((lang) => lang !== explainLang)!;
      const prompt = buildExplainSystemPrompt(targetLang, explainLang);

      expect(prompt).toMatch(ORIGINAL_MESSAGE_KEYWORDS[explainLang]);
    }
  });
});

describe("buildExplainUserPrompt", () => {
  it("チャット本文をそのまま埋め込んだユーザープロンプトを組み立てる", () => {
    const prompt = buildExplainUserPrompt("gg no re chat");

    expect(prompt).toContain("gg no re chat");
  });
});

describe("buildTriageUserPrompt", () => {
  it("チャット本文をそのまま埋め込んだユーザープロンプトを組み立てる", () => {
    const prompt = buildTriageUserPrompt("gg no re chat");

    expect(prompt).toContain("gg no re chat");
  });

  it("真偽値での回答を明示的に指示する", () => {
    const prompt = buildTriageUserPrompt("gg no re chat");

    expect(prompt).toMatch(/true/i);
    expect(prompt).toMatch(/false/i);
  });

  it("@メンションのみで実質的な内容がない発言はfalseと判定する基準を明示する", () => {
    const prompt = buildTriageUserPrompt("@kitano85 hiiii :)");

    expect(prompt).toMatch(/@mention|mention/i);
  });

  it("代名詞・前置詞・数字など基礎語彙のみの発言はfalseと判定する基準を明示する", () => {
    const prompt = buildTriageUserPrompt("I spent 300 in skincare last time");

    expect(prompt).toMatch(/basic vocabulary|beginner already knows/i);
  });
});
