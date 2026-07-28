/**
 * src/app/settings/page.tsx のテスト。
 *
 * Phase 0 の完了条件である「環境診断画面が Prompt API の可用性を表示する」導線を検証する。
 * ブラウザ組み込みAPIへの実アクセスは `runBrowserDiagnosis` に閉じ込めているため、
 * ここではそのモジュールをモックしてページの表示ロジックのみを確認する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: vi.fn(),
}));

import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";

/** 全項目が利用可能な基準診断結果(お使いの Chrome 150 相当を想定) */
const readyDiagnosis: EnvironmentDiagnosis = {
  chromeVersion: 150,
  meetsMinimumChromeVersion: true,
  languageModel: { supported: true, availability: "available" },
  languageDetector: { supported: true, availability: "available" },
  storageEstimate: { quota: 100_000_000_000, usage: 1_000_000_000 },
  overallReady: true,
};

afterEach(() => {
  vi.mocked(runBrowserDiagnosis).mockReset();
});

describe("SettingsPage", () => {
  it("マウント時に診断を実行し、Prompt API が利用可能であることを表示する", async () => {
    vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);

    render(<SettingsPage />);

    expect(screen.getByText(/診断中/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText(/Prompt API はすぐに利用できます/)).toBeInTheDocument();
    });
  });

  it("再診断ボタンを押すと runBrowserDiagnosis が再度呼び出される", async () => {
    vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
    const user = userEvent.setup();

    render(<SettingsPage />);
    const retryButton = await screen.findByRole("button", { name: /再診断/ });

    await user.click(retryButton);

    await waitFor(() => {
      expect(runBrowserDiagnosis).toHaveBeenCalledTimes(2);
    });
  });

  it("診断処理が失敗した場合はエラーメッセージを表示する", async () => {
    vi.mocked(runBrowserDiagnosis).mockRejectedValue(new Error("navigator is not defined"));

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText(/診断中にエラーが発生しました/)).toBeInTheDocument();
    });
  });

  it("Chrome バージョンが要件未満の場合はエラーメッセージを表示する", async () => {
    vi.mocked(runBrowserDiagnosis).mockResolvedValue({
      ...readyDiagnosis,
      chromeVersion: 120,
      meetsMinimumChromeVersion: false,
    });

    render(<SettingsPage />);

    await waitFor(() => {
      expect(screen.getByText(/Chrome 148 以降が必要です/)).toBeInTheDocument();
    });
  });
});
