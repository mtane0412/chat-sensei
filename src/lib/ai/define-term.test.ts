/**
 * src/lib/ai/define-term.ts のテスト。
 *
 * `defineTerm`: ユーザーが範囲選択した語句の意味を SessionPool 経由で生成し、
 * Gemini Nano が返した JSON 文字列を zod でパース・検証するところまでを検証する(issue #72)。
 * ユーザー操作起点のため、既定の優先度が high であることも検証する。
 * `createDefineTermBaseSessionFactory`: 設定・言語ペア・配信の文脈から、手動Pick up専用の
 * システムプロンプトを持つセッションファクトリを組み立てられることを検証する
 * (`LanguageModel` はブラウザ組み込みAPIのため `vi.stubGlobal` でモックする)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { createDefineTermBaseSessionFactory, defineTerm } from "./define-term";
import { buildDefineTermSystemPrompt } from "./prompts";
import type { SessionPool } from "./session-pool";

/** テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出し、prompt への入力を記録する */
function createFakeSessionPool(promptResult: string) {
  const promptMock = vi.fn(async () => promptResult);
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt: promptMock });
  });
  const pool = { enqueue } as unknown as SessionPool & { enqueue: typeof enqueue };
  return { pool, promptMock };
}

describe("defineTerm", () => {
  it("Gemini Nano が返した JSON をパースし、選択した語句の意味として返す", async () => {
    const { pool } = createFakeSessionPool(JSON.stringify({ meaning: "リマッチは無しという潔い挨拶" }));

    const result = await defineTerm(pool, "no re", "gg no re chat");

    expect(result.meaning).toBe("リマッチは無しという潔い挨拶");
  });

  it("ユーザー操作起点のため、既定で high 優先度として enqueue する", async () => {
    const { pool } = createFakeSessionPool(JSON.stringify({ meaning: "意味" }));

    await defineTerm(pool, "no re", "gg no re chat");

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), undefined);
  });

  it("signal を指定した場合はそのまま enqueue に渡す", async () => {
    const { pool } = createFakeSessionPool(JSON.stringify({ meaning: "意味" }));
    const controller = new AbortController();

    await defineTerm(pool, "no re", "gg no re chat", { signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("high", expect.any(Function), controller.signal);
  });

  it("選択した語句と発言本文の両方を含むユーザープロンプトを送る", async () => {
    const { pool, promptMock } = createFakeSessionPool(JSON.stringify({ meaning: "意味" }));

    await defineTerm(pool, "no re", "gg no re chat");

    const [userPrompt] = promptMock.mock.calls[0] as unknown as [string];
    expect(userPrompt).toContain('"no re"');
    expect(userPrompt).toContain('"gg no re chat"');
  });

  it("応答が JSON として解釈できない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const { pool } = createFakeSessionPool("これはJSONではない文字列です");

    await expect(defineTerm(pool, "no re", "gg no re chat")).rejects.toThrow();
  });

  it("応答の JSON がスキーマに合わない場合はエラーを投げる(meaning が空)", async () => {
    const { pool } = createFakeSessionPool(JSON.stringify({ meaning: "" }));

    await expect(defineTerm(pool, "no re", "gg no re chat")).rejects.toThrow();
  });
});

describe("createDefineTermBaseSessionFactory", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gemini-nano 設定では、手動Pick up専用のシステムプロンプト(配信の文脈込み)で LanguageModel.create を呼ぶ", async () => {
    const create = vi.fn(async () => ({ prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() }));
    vi.stubGlobal("LanguageModel", { create });
    const streamContext = { title: "Road to Gladiator", category: "World of Warcraft" };

    const factory = createDefineTermBaseSessionFactory(DEFAULT_SETTINGS, "en", "ja", streamContext);
    await factory();

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        initialPrompts: [{ role: "system", content: buildDefineTermSystemPrompt("en", "ja", streamContext) }],
      }),
    );
  });
});
