/**
 * src/lib/ai/translate.ts のテスト。
 *
 * `translateChatMessage`: SessionPool 経由でチャット本文の翻訳を生成し、
 * Gemini Nano が返したJSON文字列を zod でパース・検証するところまでを検証する
 * (共通処理 `runStructuredPrompt` に翻訳用のプロンプト・スキーマが正しく渡ることの確認)。
 * `createTranslateBaseSessionFactory`: 言語ペアから翻訳専用のシステムプロンプトで
 * `LanguageModel.create()` を呼び出すセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込みAPIのため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExplainSystemPrompt } from "./prompts";
import type { SessionPool } from "./session-pool";
import { STRUCTURED_PROMPT_MAX_ATTEMPTS } from "./structured-prompt";
import { createTranslateBaseSessionFactory, translateChatMessage } from "./translate";

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

describe("translateChatMessage", () => {
  it("Gemini Nanoが返したJSONを翻訳結果としてパースして返す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "ナイスプレー、チャット" }));

    const result = await translateChatMessage(pool, "gg chat");

    expect(result).toEqual({ translation: "ナイスプレー、チャット" });
  });

  it("翻訳は全件自動生成のため、優先度を指定しない場合は既定で low として enqueue する", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "t" }));

    await translateChatMessage(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), undefined);
  });

  it("優先度とsignalを指定した場合はそのままenqueueに渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "t" }));
    const controller = new AbortController();

    await translateChatMessage(pool, "hello", { priority: "high", signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), controller.signal);
  });

  it("翻訳用のユーザープロンプトと翻訳用のresponseConstraintでsession.promptを呼ぶ", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "t" }));

    await translateChatMessage(pool, "gg chat");

    expect(pool.prompt).toHaveBeenCalledWith(
      expect.stringContaining("gg chat"),
      expect.objectContaining({
        responseConstraint: expect.objectContaining({ required: ["translation"] }),
      }),
    );
  });

  it("placeholderTokens を指定した場合は、そのトークンの説明をユーザープロンプトに含める(issue #44)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "t" }));

    await translateChatMessage(pool, "Ello [[E0]]", { placeholderTokens: ["[[E0]]"] });

    expect(pool.prompt).toHaveBeenCalledWith(expect.stringMatching(/\[\[E0\]\].*emote/), expect.anything());
  });

  it("応答がJSONとして解釈できない場合はエラーを投げる", async () => {
    const pool = createFakeSessionPool("これはJSONではない文字列です");

    await expect(translateChatMessage(pool, "hello")).rejects.toThrow();
  });

  it("応答のJSONがスキーマに合わない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ text: "訳文がtranslationキーに入っていない" }));

    await expect(translateChatMessage(pool, "hello")).rejects.toThrow();
  });

  describe("JSON 解釈失敗時の再試行(issue #19)", () => {
    it("応答が正常な場合は1回しか enqueue しない", async () => {
      const pool = createFakeSessionPool(JSON.stringify({ translation: "マジか！" }));

      await translateChatMessage(pool, "no way");

      expect(pool.enqueue).toHaveBeenCalledTimes(1);
    });

    it("応答 JSON が途中で切れていた場合は、新しいジョブとして1回だけ再試行し、成功した結果を返す", async () => {
      const truncated = '{"translation":"マジか！';
      const pool = createFakeSessionPool([truncated, JSON.stringify({ translation: "マジか！" })]);

      const result = await translateChatMessage(pool, "no way");

      expect(result).toEqual({ translation: "マジか！" });
      expect(pool.enqueue).toHaveBeenCalledTimes(2);
      // 2回目も同じ優先度・signal で積み直す
      expect(pool.enqueue).toHaveBeenNthCalledWith(2, "low", expect.any(Function), undefined);
    });

    it("再試行しても JSON として解釈できない場合は、それ以上再試行せず試行回数を含めたエラーを投げる", async () => {
      const pool = createFakeSessionPool(['{"translation":"へー、なしか。', '{"translation":"へー、']);

      await expect(translateChatMessage(pool, "oh no way")).rejects.toThrow(
        `Could not parse the Prompt API response as JSON (${STRUCTURED_PROMPT_MAX_ATTEMPTS} attempts): {"translation":"へー、`,
      );
      expect(pool.enqueue).toHaveBeenCalledTimes(STRUCTURED_PROMPT_MAX_ATTEMPTS);
    });

    it("JSON としては解釈できるがスキーマに合わない応答は再試行しない", async () => {
      const pool = createFakeSessionPool([
        JSON.stringify({ text: "キー違い" }),
        JSON.stringify({ translation: "再試行されれば返る訳文" }),
      ]);

      await expect(translateChatMessage(pool, "hello")).rejects.toThrow();
      expect(pool.enqueue).toHaveBeenCalledTimes(1);
    });
  });
});

describe("createTranslateBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("翻訳専用のsystem promptとexpectedInputs/expectedOutputsでLanguageModel.createを呼ぶ", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
      expectedInputs: Array<{ type: string; languages: string[] }>;
      expectedOutputs: Array<{ type: string; languages: string[] }>;
    }

    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });

    const factory = createTranslateBaseSessionFactory("en", "ja");
    const session = await factory();

    expect(session).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0];
    expect(options.initialPrompts).toHaveLength(1);
    expect(options.initialPrompts[0].role).toBe("system");
    expect(options.initialPrompts[0].content).toContain("日本語");
    // 解説用のシステムプロンプトを流用していないこと
    expect(options.initialPrompts[0].content).not.toBe(buildExplainSystemPrompt("en", "ja"));
    expect(options.expectedInputs).toEqual([{ type: "text", languages: ["en", "ja"] }]);
    expect(options.expectedOutputs).toEqual([{ type: "text", languages: ["ja"] }]);
  });
});
