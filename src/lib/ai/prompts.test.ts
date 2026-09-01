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
  buildTranslateSystemPrompt,
  buildTranslateUserPrompt,
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

  it("解説言語がjaのとき、代名詞・数字・記号単体・@メンションを列挙しない指示を含む", () => {
    const prompt = buildExplainSystemPrompt("en", "ja");

    expect(prompt).toMatch(/代名詞/);
    expect(prompt).toMatch(/メンション/);
  });

  it("学ぶ言語が日本語のとき、英語の前置詞ではなく日本語の助詞(基本的な機能語)を列挙しない指示になる", () => {
    // 除外ルールが英語の文法カテゴリ(前置詞)決め打ちだと、targetLangが日本語の場合に
    // 「は」「を」等の助詞がノイズとして抽出され続けてしまうため、学ぶ言語に応じた
    // 機能語(前置詞・助詞・冠詞など)を指すことを検証する
    const prompt = buildExplainSystemPrompt("ja", "en");

    expect(prompt).toMatch(/particle/i);
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

describe("buildTranslateSystemPrompt", () => {
  it("解説言語がjaのとき、学ぶ言語から日本語への翻訳を指示する日本語のシステムプロンプトを組み立てる", () => {
    const prompt = buildTranslateSystemPrompt("en", "ja");

    expect(prompt).toContain("英語");
    expect(prompt).toContain("日本語");
    expect(prompt).toMatch(/翻訳/);
  });

  it("解説言語がenのとき、英語のシステムプロンプトを組み立てる", () => {
    const prompt = buildTranslateSystemPrompt("ja", "en");

    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("English");
    expect(prompt).toMatch(/translat/i);
  });

  it("解説用のシステムプロンプトとは別物である(語句の列挙など解説向けの指示を含まない)", () => {
    const prompt = buildTranslateSystemPrompt("en", "ja");

    expect(prompt).not.toBe(buildExplainSystemPrompt("en", "ja"));
    expect(prompt).not.toMatch(/items/);
  });

  it("すべてのサポート言語の組み合わせでエラーなくプロンプトを生成できる", () => {
    for (const targetLang of SUPPORTED_LANGUAGES) {
      for (const explainLang of SUPPORTED_LANGUAGES) {
        if (targetLang === explainLang) continue;
        expect(() => buildTranslateSystemPrompt(targetLang, explainLang)).not.toThrow();
      }
    }
  });
});

describe("buildTranslateUserPrompt", () => {
  it("チャット本文をそのまま埋め込んだユーザープロンプトを組み立てる", () => {
    const prompt = buildTranslateUserPrompt("gg no re chat");

    expect(prompt).toContain("gg no re chat");
  });

  it("解説用のユーザープロンプトとは異なる文言で翻訳対象であることを示す", () => {
    expect(buildTranslateUserPrompt("hello")).not.toBe(buildExplainUserPrompt("hello"));
  });
});
