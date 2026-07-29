/**
 * src/lib/ai/triage.ts のテスト。
 *
 * `triageChatMessage`: SessionPool経由で「学習者にとって学ぶ価値があるか」を
 * 真偽値で判定し、Gemini Nanoが返したJSON文字列をzodで検証するところまでを検証する。
 * explain.test.tsと同様、`LanguageModel`はブラウザ組み込みAPIのため実際には呼び出さず、
 * SessionPoolのフェイクで置き換える。
 */
import { describe, expect, it, vi } from "vitest";
import { triageChatMessage } from "./triage";
import type { SessionPool } from "./session-pool";

/** テスト用の最小限の SessionPool フェイク。enqueue の run をそのまま呼び出す */
function createFakeSessionPool(promptResult: string) {
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    const fakeSession = { prompt: vi.fn(async () => promptResult) };
    return run(fakeSession);
  });
  return { enqueue } as unknown as SessionPool & { enqueue: typeof enqueue };
}

describe("triageChatMessage", () => {
  it("Gemini Nanoがtrueを返した場合はtrueを返す", async () => {
    const pool = createFakeSessionPool("true");

    const result = await triageChatMessage(pool, "that clip was so clutch, gg");

    expect(result).toBe(true);
  });

  it("Gemini Nanoがfalseを返した場合はfalseを返す", async () => {
    const pool = createFakeSessionPool("false");

    const result = await triageChatMessage(pool, "hello everyone");

    expect(result).toBe(false);
  });

  it("常に低優先度('low')でenqueueする(自動抽出は手動ピックより優先度が低いため)", async () => {
    const pool = createFakeSessionPool("true");

    await triageChatMessage(pool, "hello");

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), undefined);
  });

  it("signalを指定した場合はそのままenqueueに渡す", async () => {
    const pool = createFakeSessionPool("true");
    const controller = new AbortController();

    await triageChatMessage(pool, "hello", { signal: controller.signal });

    expect(pool.enqueue).toHaveBeenCalledWith("low", expect.any(Function), controller.signal);
  });

  it("応答がJSONとして解釈できない場合は分かりやすいエラーを投げる", async () => {
    const pool = createFakeSessionPool("これはJSONではない文字列です");

    await expect(triageChatMessage(pool, "hello")).rejects.toThrow();
  });

  it("応答が真偽値でない場合はエラーを投げる(自由文パースへのフォールバックはしない)", async () => {
    const pool = createFakeSessionPool(JSON.stringify({ worthLearning: true }));

    await expect(triageChatMessage(pool, "hello")).rejects.toThrow();
  });
});
