/**
 * src/lib/ai/openrouter.ts(OpenRouter API クライアント)のテスト。
 *
 * ネットワークには触れず、fetch のフェイクを注入して以下を検証する。
 * - モデル一覧 API(GET /models)の取得・整形・失敗時の例外(Fail-Fast)
 * - `PromptSessionLike` 互換セッションが chat/completions へ正しいリクエストを送ること
 * - 応答の取り出しと、HTTP エラー時に理由付きの例外を投げること
 */
import { describe, expect, it, vi } from "vitest";
import { createOpenRouterSessionFactory, fetchOpenRouterModels, OPENROUTER_API_BASE_URL } from "./openrouter";

/** fetch のフェイクを組み立てる。返す JSON とステータスを指定できる */
function createFetchFake(body: unknown, init: { status?: number } = {}) {
  return vi.fn(async (): Promise<Response> => {
    return new Response(JSON.stringify(body), { status: init.status ?? 200 });
  });
}

describe("fetchOpenRouterModels", () => {
  it("モデル一覧を id 昇順で返し、name が無いモデルは id を表示名にする", async () => {
    const fetchFake = createFetchFake({
      data: [
        { id: "openai/gpt-5", name: "GPT-5" },
        { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "meta-llama/llama-4" },
      ],
    });

    const models = await fetchOpenRouterModels(fetchFake);

    expect(fetchFake).toHaveBeenCalledWith(`${OPENROUTER_API_BASE_URL}/models`);
    expect(models).toEqual([
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" },
      { id: "meta-llama/llama-4", name: "meta-llama/llama-4" },
      { id: "openai/gpt-5", name: "GPT-5" },
    ]);
  });

  it("HTTP エラーの場合はステータスコードを含む例外を投げる(暗黙に空一覧へフォールバックしない)", async () => {
    const fetchFake = createFetchFake({ error: { message: "Internal Server Error" } }, { status: 500 });

    await expect(fetchOpenRouterModels(fetchFake)).rejects.toThrow(/500/);
  });

  it("応答がスキーマに合わない場合は例外を投げる", async () => {
    const fetchFake = createFetchFake({ models: "これは想定した形ではない" });

    await expect(fetchOpenRouterModels(fetchFake)).rejects.toThrow();
  });
});

describe("createOpenRouterSessionFactory", () => {
  const config = {
    apiKey: "sk-or-v1-test-key-0123",
    model: "anthropic/claude-sonnet-5",
    systemPrompt: "あなたはTwitchチャットの翻訳者です",
  };

  /** chat/completions の正常応答を返す fetch フェイク */
  function createCompletionFetchFake(content: string) {
    return createFetchFake({ choices: [{ message: { content } }] });
  }

  it("システムプロンプト・ユーザープロンプト・responseConstraint を chat/completions のリクエストに組み立てる", async () => {
    const fetchFake = createCompletionFetchFake('{"translation":"ナイスプレー"}');
    const session = await createOpenRouterSessionFactory(config, fetchFake)();

    const constraint = { type: "object", properties: { translation: { type: "string" } } };
    const result = await session.prompt("nice play", { responseConstraint: constraint });

    expect(result).toBe('{"translation":"ナイスプレー"}');
    expect(fetchFake).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_API_BASE_URL}/chat/completions`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${config.apiKey}`);
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({
      model: config.model,
      messages: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: "nice play" },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: constraint },
      },
    });
  });

  it("responseConstraint を渡さない場合は response_format を付けない", async () => {
    const fetchFake = createCompletionFetchFake("こんにちは");
    const session = await createOpenRouterSessionFactory(config, fetchFake)();

    await session.prompt("hello");

    const [, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("response_format");
  });

  it("HTTP エラーの場合はステータスコードと本文の理由を含む例外を投げる", async () => {
    const fetchFake = createFetchFake({ error: { message: "Invalid API key" } }, { status: 401 });
    const session = await createOpenRouterSessionFactory(config, fetchFake)();

    await expect(session.prompt("hello")).rejects.toThrow(/401.*Invalid API key/);
  });

  it("応答に choices が無い場合は例外を投げる(暗黙に空文字へフォールバックしない)", async () => {
    const fetchFake = createFetchFake({ choices: [] });
    const session = await createOpenRouterSessionFactory(config, fetchFake)();

    await expect(session.prompt("hello")).rejects.toThrow();
  });

  it("clone したセッションも同じ設定でリクエストでき、destroy は例外を投げない", async () => {
    const fetchFake = createCompletionFetchFake("よい試合でした");
    const session = await createOpenRouterSessionFactory(config, fetchFake)();

    const cloned = await session.clone();
    const result = await cloned.prompt("gg");

    expect(result).toBe("よい試合でした");
    expect(() => {
      cloned.destroy();
      session.destroy();
    }).not.toThrow();
  });

  it("prompt の signal を fetch に引き渡す(パイプライン停止時に実行中のリクエストを中断できるようにする)", async () => {
    const fetchFake = createCompletionFetchFake("ok");
    const session = await createOpenRouterSessionFactory(config, fetchFake)();
    const controller = new AbortController();

    await session.prompt("hello", { signal: controller.signal });

    const [, init] = fetchFake.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.signal).toBe(controller.signal);
  });
});
