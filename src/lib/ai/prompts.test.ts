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
});
