/**
 * src/lib/ai/llm-provider.ts(LLM プロバイダ切替層)のテスト。
 *
 * 設定 `llmProvider` に応じて、Gemini Nano(Prompt API)用と OpenRouter 用のどちらの
 * ベースセッション生成関数が組み立てられるかを検証する。実ブラウザ API・ネットワークには触れず、
 * `LanguageModel` と `fetch` はグローバルのスタブを注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { createLlmBaseSessionFactory } from "./llm-provider";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 翻訳用を模したシステムプロンプトの組み立て関数(言語ペアが渡ることを検証できる形にする) */
function buildSystemPrompt(targetLang: string, explainLang: string): string {
  return `${targetLang} のチャットを ${explainLang} に翻訳してください`;
}

describe("createLlmBaseSessionFactory", () => {
  it("Gemini Nano プロバイダでは LanguageModel.create でベースセッションを生成する", async () => {
    const fakeSession = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn(async () => fakeSession);
    vi.stubGlobal("LanguageModel", { create });

    const factory = createLlmBaseSessionFactory(DEFAULT_SETTINGS, buildSystemPrompt, "en", "ja");
    const session = await factory();

    expect(session).toBe(fakeSession);
    expect(create).toHaveBeenCalledWith({
      initialPrompts: [{ role: "system", content: "en のチャットを ja に翻訳してください" }],
      expectedInputs: [{ type: "text", languages: ["en", "ja"] }],
      expectedOutputs: [{ type: "text", languages: ["ja"] }],
    });
  });

  it("OpenRouter プロバイダでは設定のキー・モデルとシステムプロンプトで chat/completions を呼ぶセッションを生成する", async () => {
    const fetchFake = vi.fn(
      async (): Promise<Response> =>
        new Response(JSON.stringify({ choices: [{ message: { content: "ナイスプレー" } }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchFake);
    const settings = {
      ...DEFAULT_SETTINGS,
      llmProvider: "openrouter" as const,
      openRouterApiKey: "sk-or-v1-test-key-0123",
      openRouterModel: "anthropic/claude-sonnet-5",
    };

    const factory = createLlmBaseSessionFactory(settings, buildSystemPrompt, "en", "ja");
    const session = await factory();
    const result = await session.prompt("nice play");

    expect(result).toBe("ナイスプレー");
    const [url, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer sk-or-v1-test-key-0123");
    const body = JSON.parse(String(init.body)) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(body.model).toBe("anthropic/claude-sonnet-5");
    expect(body.messages[0]).toEqual({ role: "system", content: "en のチャットを ja に翻訳してください" });
  });
});
