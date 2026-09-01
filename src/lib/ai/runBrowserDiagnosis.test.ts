/**
 * src/lib/ai/runBrowserDiagnosis.ts のテスト。
 *
 * `runBrowserDiagnosis` は実行中のブラウザのグローバルオブジェクト
 * (`navigator`, `LanguageModel`, `LanguageDetector`)から依存性を組み立て、
 * 純粋関数である `diagnoseEnvironment` に橋渡しするだけの薄い層である。
 * `vi.stubGlobal` でブラウザAPIの有無をシミュレートし、正しく橋渡しできることを確認する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserDiagnosis } from "./runBrowserDiagnosis";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** テスト用の最小限の navigator スタブを作る(jsdom の Navigator.prototype は userAgent が getter-only のため素の object を使う) */
function stubNavigator(overrides: { userAgent: string; storage?: { estimate: () => Promise<{ quota?: number; usage?: number }> } }) {
  vi.stubGlobal("navigator", overrides);
}

describe("runBrowserDiagnosis", () => {
  it("LanguageModel / LanguageDetector が存在しない場合は非対応として診断する", async () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.187 Safari/537.36",
    });

    const result = await runBrowserDiagnosis();

    expect(result.chromeVersion).toBe(150);
    expect(result.languageModel).toEqual({ supported: false, availability: null });
  });

  it("window.LanguageModel / window.LanguageDetector が存在する場合はそれぞれの availability() を呼び出して反映する", async () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.187 Safari/537.36",
    });
    vi.stubGlobal("LanguageModel", { availability: async () => "available" as const });
    vi.stubGlobal("LanguageDetector", { availability: async () => "available" as const });

    const result = await runBrowserDiagnosis();

    expect(result.languageModel).toEqual({ supported: true, availability: "available" });
    expect(result.languageDetector).toEqual({ supported: true, availability: "available" });
    expect(result.overallReady).toBe(true);
  });

  it("navigator.storage.estimate が使える場合は quota/usage を反映する", async () => {
    stubNavigator({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.187 Safari/537.36",
      storage: { estimate: async () => ({ quota: 500, usage: 100 }) },
    });

    const result = await runBrowserDiagnosis();

    expect(result.storageEstimate).toEqual({ quota: 500, usage: 100 });
  });
});
