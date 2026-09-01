/**
 * src/lib/ai/pickup.ts のテスト。
 *
 * `pickUpExpressions`: SessionPool 経由でチャット本文から注目の表現(語句と意味のペア)を
 * 抽出し、Gemini Nano が返したJSON文字列を zod でパース・検証するところまでを検証する。
 * `createPickupBaseSessionFactory`: 言語ペアから Pick up 専用のシステムプロンプトで
 * `LanguageModel.create()` を呼び出すセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込みAPIのため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPickupBaseSessionFactory, pickUpExpressions } from "./pickup";
import { buildExplainSystemPrompt, buildTranslateSystemPrompt } from "./prompts";
import type { SessionPool } from "./session-pool";

/** テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出し、prompt の引数を記録する */
function createFakeSessionPool(promptResult: string) {
  const prompt = vi.fn(async () => promptResult);
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt });
  });
  return { enqueue, prompt } as unknown as SessionPool & { enqueue: typeof enqueue; prompt: typeof prompt };
}

const サンプル抽出結果 = {
  terms: [
    { term: "cooked", meaning: "もうダメ、終わってる" },
    { term: "touch grass", meaning: "外に出て現実を見ろ" },
  ],
};

describe("pickUpExpressions", () => {
  it("Gemini Nanoが返したJSONを語句と意味のペアの一覧としてパースして返す", async () => {
    const pool = createFakeSessionPool(JSON.stringify(サンプル抽出結果));

    const result = await pickUpExpressions(pool, "bro is cooked lmao touch grass");

    expect(result).toEqual(サンプル抽出結果);
  });

  it("抽出は全件自動生成のため、優先度を指定しない場合は既定で low として enqueue する", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), undefined);
  });

  it("優先度とsignalを指定した場合はそのままenqueueに渡す", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));
    const controller = new AbortController();

    await pickUpExpressions(pool, "hello", { priority: "high", signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), controller.signal);
  });

  it("Pick up用のユーザープロンプトとPick up用のresponseConstraintでsession.promptを呼ぶ", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [] }));

    await pickUpExpressions(pool, "gg chat");

    expect(pool.prompt).toHaveBeenCalledWith(
      expect.stringContaining("gg chat"),
      expect.objectContaining({
        responseConstraint: expect.objectContaining({ required: ["terms"] }),
      }),
    );
  });

  it("応答がJSONとして解釈できない場合はエラーを投げる", async () => {
    const pool = createFakeSessionPool("これはJSONではない文字列です");

    await expect(pickUpExpressions(pool, "hello")).rejects.toThrow();
  });

  it("応答のJSONがスキーマに合わない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ items: [{ term: "gg", meaning: "x" }] }));

    await expect(pickUpExpressions(pool, "hello")).rejects.toThrow();
  });
});

describe("pickUpExpressions(原文との照合)", () => {
  it("大文字小文字の違いは許容する(「W」を「w」として返しても原文の語句とみなす)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "w", meaning: "勝利" }] }));

    const result = await pickUpExpressions(pool, "that was a W");

    expect(result.terms).toEqual([{ term: "w", meaning: "勝利" }]);
  });

  it("原文に登場しない語句が含まれる場合はエラーを投げる(解説言語の語や言い換えを原文の語句として表示しない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ terms: [{ term: "了解", meaning: "分かった" }] }));

    await expect(pickUpExpressions(pool, "roger that")).rejects.toThrow(/原文に登場しない/);
  });
});

describe("createPickupBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Pick up専用のsystem promptとexpectedInputs/expectedOutputsでLanguageModel.createを呼ぶ", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
      expectedInputs: Array<{ type: string; languages: string[] }>;
      expectedOutputs: Array<{ type: string; languages: string[] }>;
    }

    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });

    const factory = createPickupBaseSessionFactory("en", "ja");
    const session = await factory();

    expect(session).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0];
    expect(options.initialPrompts).toHaveLength(1);
    expect(options.initialPrompts[0].role).toBe("system");
    expect(options.initialPrompts[0].content).toContain("日本語");
    // 解説用・翻訳用のシステムプロンプトを流用していないこと
    expect(options.initialPrompts[0].content).not.toBe(buildExplainSystemPrompt("en", "ja"));
    expect(options.initialPrompts[0].content).not.toBe(buildTranslateSystemPrompt("en", "ja"));
    expect(options.expectedInputs).toEqual([{ type: "text", languages: ["en", "ja"] }]);
    expect(options.expectedOutputs).toEqual([{ type: "text", languages: ["ja"] }]);
  });
});
