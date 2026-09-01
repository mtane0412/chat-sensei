/**
 * src/lib/ai/describeDiagnosis.ts のテスト。
 *
 * EnvironmentDiagnosis を、設定画面にそのまま表示できる
 * 日本語メッセージ + 重大度(ok/warning/error)のリストに変換する純関数を検証する。
 */
import { describe, expect, it } from "vitest";
import { describeDiagnosis } from "./describeDiagnosis";
import type { EnvironmentDiagnosis } from "./availability";

/** テストケースごとに上書きしやすいよう、全項目「利用可能」な基準状態を用意する */
function baseDiagnosis(overrides: Partial<EnvironmentDiagnosis> = {}): EnvironmentDiagnosis {
  return {
    chromeVersion: 150,
    meetsMinimumChromeVersion: true,
    languageModel: { supported: true, availability: "available" },
    languageDetector: { supported: true, availability: "available" },
    storageEstimate: { quota: 100_000_000_000, usage: 1_000_000_000 },
    overallReady: true,
    ...overrides,
  };
}

describe("describeDiagnosis", () => {
  it("すべて利用可能な場合は error を含まず、Prompt API の項目は ok になる", () => {
    const messages = describeDiagnosis(baseDiagnosis());

    expect(messages.some((m) => m.level === "error")).toBe(false);
    expect(messages.find((m) => m.id === "language-model")?.level).toBe("ok");
  });

  it("Chrome バージョンが最小要件未満の場合は error でバージョンアップを促す", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ chromeVersion: 120, meetsMinimumChromeVersion: false }),
    );

    const versionMessage = messages.find((m) => m.id === "chrome-version");
    expect(versionMessage?.level).toBe("error");
    expect(versionMessage?.message).toContain("148");
  });

  it("Chrome 自体を検出できない場合は error でブラウザ変更を促す", () => {
    const messages = describeDiagnosis(baseDiagnosis({ chromeVersion: null, meetsMinimumChromeVersion: false }));

    const versionMessage = messages.find((m) => m.id === "chrome-version");
    expect(versionMessage?.level).toBe("error");
    expect(versionMessage?.message).toContain("Chrome");
  });

  it("LanguageModel が未対応(supported: false)の場合は error で理由を明示する", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ languageModel: { supported: false, availability: null } }),
    );

    const lmMessage = messages.find((m) => m.id === "language-model");
    expect(lmMessage?.level).toBe("error");
    expect(lmMessage?.message).toContain("Prompt API");
  });

  it("LanguageModel.availability() が 'unavailable' の場合は error", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ languageModel: { supported: true, availability: "unavailable" } }),
    );

    const lmMessage = messages.find((m) => m.id === "language-model");
    expect(lmMessage?.level).toBe("error");
  });

  it("LanguageModel.availability() が 'downloadable' の場合は warning でユーザー操作が必要と伝える", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ languageModel: { supported: true, availability: "downloadable" } }),
    );

    const lmMessage = messages.find((m) => m.id === "language-model");
    expect(lmMessage?.level).toBe("warning");
    expect(lmMessage?.message).toContain("download");
  });

  it("LanguageModel.availability() が 'available' の場合は ok", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ languageModel: { supported: true, availability: "available" } }),
    );

    const lmMessage = messages.find((m) => m.id === "language-model");
    expect(lmMessage?.level).toBe("ok");
  });

  // 実機の Chrome 150 で検証したところ、navigator.storage.estimate().quota は
  // 「このオリジン専用のストレージ割り当て」(実測値: 約10GB)であり、
  // Prompt API が要求する「OSの空き容量22GB」とは無関係の指標だと判明した。
  // そのため quota の大小で警告を出すのではなく、両者が別物である旨を情報提示のみ行う。
  it("storageEstimate.quota を取得できた場合は参考値として ok で表示し、OSの空き容量とは別指標である旨を明記する", () => {
    const tenGb = 10 * 1024 * 1024 * 1024;
    const messages = describeDiagnosis(baseDiagnosis({ storageEstimate: { quota: tenGb, usage: 0 } }));

    const storageMessage = messages.find((m) => m.id === "storage");
    expect(storageMessage?.level).toBe("ok");
    expect(storageMessage?.message).toContain("10.0GB");
    expect(storageMessage?.message).toContain("22GB");
  });

  it("storageEstimate が取得できない(null)場合は warning で取得不可を伝える", () => {
    const messages = describeDiagnosis(baseDiagnosis({ storageEstimate: { quota: null, usage: null } }));

    const storageMessage = messages.find((m) => m.id === "storage");
    expect(storageMessage?.level).toBe("warning");
  });

  it("languageDetector が未対応の場合は warning(必須機能ではないため error にしない)", () => {
    const messages = describeDiagnosis(
      baseDiagnosis({ languageDetector: { supported: false, availability: null } }),
    );

    const ldMessage = messages.find((m) => m.id === "language-detector");
    expect(ldMessage?.level).toBe("warning");
  });
});
