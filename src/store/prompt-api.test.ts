/**
 * src/store/prompt-api.ts(Prompt API の利用可否を 1 か所で保持する共有ストア)のテスト。
 *
 * 環境診断を 1 回だけ実行して結果を共有し、翻訳列と Pick up 列が同じ可否状態を参照できることを検証する。
 * 環境診断はフェイクを注入し、実ブラウザ API には触れない。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { createDeferred, createDiagnosis, flush } from "./pipeline-test-fixtures";
import {
  ensurePromptApiDiagnosed,
  markPromptApiUnavailable,
  resetPromptApiStoreForTests,
  usePromptApiStore,
} from "./prompt-api";

afterEach(() => {
  resetPromptApiStoreForTests();
});

describe("ensurePromptApiDiagnosed", () => {
  it("初期状態は checking で、診断が成功すると ready を返しストアも ready になる", async () => {
    expect(usePromptApiStore.getState().status).toEqual({ status: "checking" });

    const status = await ensurePromptApiDiagnosed(async () => createDiagnosis(true));

    expect(status).toEqual({ status: "ready" });
    expect(usePromptApiStore.getState().status).toEqual({ status: "ready" });
  });

  it("診断で Prompt API が使えない場合は、利用者に見せる理由付きで unavailable になる", async () => {
    const status = await ensurePromptApiDiagnosed(async () => createDiagnosis(false));

    expect(status.status).toBe("unavailable");
    expect(status.status === "unavailable" && status.reason).toMatch(/Prompt API/);
    expect(usePromptApiStore.getState().status).toEqual(status);
  });

  it("診断そのものが失敗した場合は、その旨を理由にした unavailable になる(暗黙に ready 扱いしない)", async () => {
    const status = await ensurePromptApiDiagnosed(async () => {
      throw new Error("navigator.storage が使えません");
    });

    expect(status).toEqual({
      status: "unavailable",
      reason: "Environment check failed: navigator.storage が使えません",
    });
  });

  it("診断中に重ねて呼ばれても診断は 1 回しか実行せず、同じ結果を返す(翻訳列と Pick up 列の食い違い防止)", async () => {
    const diagnosis = createDeferred<EnvironmentDiagnosis>();
    const diagnose = vi.fn(() => diagnosis.promise);

    const first = ensurePromptApiDiagnosed(diagnose);
    const second = ensurePromptApiDiagnosed(diagnose);
    expect(usePromptApiStore.getState().status).toEqual({ status: "checking" });

    diagnosis.resolve(createDiagnosis(true));
    await flush();

    expect(diagnose).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toEqual({ status: "ready" });
    await expect(second).resolves.toEqual({ status: "ready" });
  });

  it("一度確定したあとは診断を再実行せず、確定済みの状態をそのまま返す", async () => {
    const diagnose = vi.fn(async () => createDiagnosis(true));
    await ensurePromptApiDiagnosed(diagnose);

    const status = await ensurePromptApiDiagnosed(diagnose);

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(status).toEqual({ status: "ready" });
  });
});

describe("markPromptApiUnavailable", () => {
  it("理由付きで unavailable にし、以後の ensurePromptApiDiagnosed もその状態を返す", async () => {
    await ensurePromptApiDiagnosed(async () => createDiagnosis(true));

    markPromptApiUnavailable("Could not create a Prompt API session: user activation is required");

    expect(usePromptApiStore.getState().status).toEqual({
      status: "unavailable",
      reason: "Could not create a Prompt API session: user activation is required",
    });
    await expect(ensurePromptApiDiagnosed(async () => createDiagnosis(true))).resolves.toEqual(
      usePromptApiStore.getState().status,
    );
  });
});
