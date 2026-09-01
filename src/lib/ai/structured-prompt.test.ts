/**
 * src/lib/ai/structured-prompt.ts のテスト。
 *
 * `runStructuredPrompt`: SessionPool にジョブを積み、Gemini Nano が返した JSON 文字列を
 * `JSON.parse` → zod スキーマの順で検証して返す共通処理を検証する。JSON として解釈できない
 * 場合に限り別ジョブとして再試行し、スキーマ不一致は再試行しないこと(issue #19)を含む。
 * `createBaseSessionFactory`: システムプロンプトの組み立て関数と言語ペアから
 * `LanguageModel.create()` を呼び出すセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込み API のため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionPool } from "./session-pool";
import { createBaseSessionFactory, runStructuredPrompt, STRUCTURED_PROMPT_MAX_ATTEMPTS } from "./structured-prompt";

/**
 * テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出し、prompt の引数を記録する。
 * 配列を渡した場合は、呼び出しごとに先頭から順に応答を返す(再試行の検証用)。
 */
function createFakeSessionPool(promptResult: string | string[]) {
  const results = Array.isArray(promptResult) ? [...promptResult] : [promptResult];
  const prompt = vi.fn(async () => {
    const next = results.shift();
    if (next === undefined) throw new Error("テスト用の応答が尽きました");
    return next;
  });
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt });
  });
  return { enqueue, prompt } as unknown as SessionPool & { enqueue: typeof enqueue; prompt: typeof prompt };
}

/** テスト用の応答スキーマ(挨拶文1つだけを持つ最小構造) */
const greetingSchema = z.object({ greeting: z.string() });

describe("runStructuredPrompt", () => {
  it("Gemini Nano が返した JSON をスキーマで検証した値として返す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ greeting: "こんにちは" }));

    const result = await runStructuredPrompt(pool, { userPrompt: "hello", schema: greetingSchema, priority: "low" });

    expect(result).toEqual({ greeting: "こんにちは" });
  });

  it("指定した優先度と signal をそのまま enqueue に渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ greeting: "t" }));
    const controller = new AbortController();

    await runStructuredPrompt(pool, {
      userPrompt: "hello",
      schema: greetingSchema,
      priority: "high",
      signal: controller.signal,
    });

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), controller.signal);
  });

  it("ユーザープロンプトと、スキーマから導出した responseConstraint で session.prompt を呼ぶ", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ greeting: "t" }));

    await runStructuredPrompt(pool, { userPrompt: "挨拶して", schema: greetingSchema, priority: "low" });

    expect(pool.prompt).toHaveBeenCalledWith(
      "挨拶して",
      expect.objectContaining({ responseConstraint: expect.objectContaining({ required: ["greeting"] }) }),
    );
  });

  it("応答の JSON がスキーマに合わない場合は再試行せずエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool([JSON.stringify({ text: "キー違い" }), JSON.stringify({ greeting: "再試行されれば返る" })]);

    await expect(
      runStructuredPrompt(pool, { userPrompt: "hello", schema: greetingSchema, priority: "low" }),
    ).rejects.toThrow();
    expect(pool.enqueue).toHaveBeenCalledTimes(1);
  });

  describe("JSON 解釈失敗時の再試行(issue #19)", () => {
    it("応答が正常な場合は1回しか enqueue しない", async () => {
      const pool = createFakeSessionPool(JSON.stringify({ greeting: "やあ" }));

      await runStructuredPrompt(pool, { userPrompt: "hello", schema: greetingSchema, priority: "low" });

      expect(pool.enqueue).toHaveBeenCalledTimes(1);
    });

    it("応答 JSON が途中で切れていた場合は、新しいジョブとして1回だけ再試行し、成功した結果を返す", async () => {
      const truncated = '{"greeting":"やあ';
      const pool = createFakeSessionPool([truncated, JSON.stringify({ greeting: "やあ" })]);

      const result = await runStructuredPrompt(pool, { userPrompt: "hello", schema: greetingSchema, priority: "low" });

      expect(result).toEqual({ greeting: "やあ" });
      expect(pool.enqueue).toHaveBeenCalledTimes(2);
      // 2回目も同じ優先度・signal で積み直す
      expect(pool.enqueue).toHaveBeenNthCalledWith(2, "low", expect.any(Function), undefined);
    });

    it("再試行しても JSON として解釈できない場合は、それ以上再試行せず試行回数を含めたエラーを投げる", async () => {
      const pool = createFakeSessionPool(['{"greeting":"やあ、', '{"greeting":"']);

      await expect(
        runStructuredPrompt(pool, { userPrompt: "hello", schema: greetingSchema, priority: "low" }),
      ).rejects.toThrow(
        `Could not parse the Prompt API response as JSON (${STRUCTURED_PROMPT_MAX_ATTEMPTS} attempts): {"greeting":"`,
      );
      expect(pool.enqueue).toHaveBeenCalledTimes(STRUCTURED_PROMPT_MAX_ATTEMPTS);
    });
  });
});

describe("createBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("buildSystemPrompt で組み立てた system prompt と言語ペアの expectedInputs/expectedOutputs で LanguageModel.create を呼ぶ", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
      expectedInputs: Array<{ type: string; languages: string[] }>;
      expectedOutputs: Array<{ type: string; languages: string[] }>;
    }

    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });
    const buildSystemPrompt = vi.fn(
      (targetLang: string, explainLang: string) => `${targetLang} を ${explainLang} で教えるチューター`,
    );

    const factory = createBaseSessionFactory(buildSystemPrompt, "en", "ja");
    const session = await factory();

    expect(session).toBe(created);
    expect(buildSystemPrompt).toHaveBeenCalledWith("en", "ja");
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0];
    expect(options.initialPrompts).toEqual([{ role: "system", content: "en を ja で教えるチューター" }]);
    expect(options.expectedInputs).toEqual([{ type: "text", languages: ["en", "ja"] }]);
    expect(options.expectedOutputs).toEqual([{ type: "text", languages: ["ja"] }]);
  });
});
