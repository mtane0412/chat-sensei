/**
 * src/lib/ai/explain.ts のテスト。
 *
 * `explainChatMessage`: SessionPool 経由でチャット本文の解説を生成し、
 * Gemini Nano が返したJSON文字列を zod でパース・検証するところまでを検証する。
 * `createExplainBaseSessionFactory`: 言語ペアから `LanguageModel.create()` を
 * 正しいオプションで呼び出すセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込みAPIのため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExplainBaseSessionFactory, explainChatMessage } from "./explain";
import type { SessionPool } from "./session-pool";

/** テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出す */
function createFakeSessionPool(promptResult: string) {
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    const fakeSession = { prompt: vi.fn(async () => promptResult) };
    return run(fakeSession);
  });
  return { enqueue } as unknown as SessionPool & { enqueue: typeof enqueue };
}

describe("explainChatMessage", () => {
  it("Gemini Nanoが返したJSONを解説結果としてパースして返す", async () => {
    const validJson = JSON.stringify({
      translation: "こんにちはチャット",
      literal: "やあチャット",
      items: [{ term: "yo", kind: "slang", meaning: "カジュアルな挨拶", note: "親しい相手へのくだけた呼びかけ" }],
      difficulty: 1,
    });
    const pool = createFakeSessionPool(validJson);

    const result = await explainChatMessage(pool, "yo chat");

    expect(result.translation).toBe("こんにちはチャット");
    expect(result.items[0].term).toBe("yo");
  });

  it("優先度を指定しない場合は既定で high として enqueue する", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({ translation: "t", literal: "l", items: [], difficulty: 1 }),
    );

    await explainChatMessage(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), undefined);
  });

  it("優先度とsignalを指定した場合はそのままenqueueに渡す", async () => {
    const pool = createFakeSessionPool(
      JSON.stringify({ translation: "t", literal: "l", items: [], difficulty: 1 }),
    );
    const controller = new AbortController();

    await explainChatMessage(pool, "hello", { priority: "low", signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), controller.signal);
  });

  it("応答がJSONとして解釈できない場合は分かりやすいエラーを投げる", async () => {
    const pool = createFakeSessionPool("これはJSONではない文字列です");

    await expect(explainChatMessage(pool, "hello")).rejects.toThrow();
  });

  it("応答のJSONがスキーマに合わない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ translation: "t" })); // itemsやdifficultyが欠けている

    await expect(explainChatMessage(pool, "hello")).rejects.toThrow();
  });
});

describe("createExplainBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("targetLang/explainLangに応じたsystem promptとexpectedInputs/expectedOutputsでLanguageModel.createを呼ぶ", async () => {
    /** LanguageModel.create() に渡されるオプションのうち、このテストで検証したい部分だけの形 */
    interface CapturedCreateOptions {
      initialPrompts: Array<{ role: string; content: string }>;
      expectedInputs: Array<{ type: string; languages: string[] }>;
      expectedOutputs: Array<{ type: string; languages: string[] }>;
    }

    const created = { prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() };
    const create = vi.fn<(options: CapturedCreateOptions) => Promise<typeof created>>(async () => created);
    vi.stubGlobal("LanguageModel", { create, availability: vi.fn() });

    const factory = createExplainBaseSessionFactory("en", "ja");
    const session = await factory();

    expect(session).toBe(created);
    expect(create).toHaveBeenCalledTimes(1);
    const options = create.mock.calls[0][0];
    expect(options.initialPrompts).toEqual([
      { role: "system", content: expect.stringContaining("日本語") },
    ]);
    expect(options.expectedInputs).toEqual([{ type: "text", languages: ["en", "ja"] }]);
    expect(options.expectedOutputs).toEqual([{ type: "text", languages: ["ja"] }]);
  });
});
