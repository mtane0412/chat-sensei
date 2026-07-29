/**
 * src/app/settings/page.tsx のテスト。
 *
 * Phase 0 の完了条件である「環境診断画面が Prompt API の可用性を表示する」導線を検証する。
 * ブラウザ組み込みAPIへの実アクセスは `runBrowserDiagnosis` に閉じ込めているため、
 * ここではそのモジュールをモックしてページの表示ロジックのみを確認する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SettingsPage from "./page";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { SETTINGS_STORAGE_KEY } from "@/lib/settings";

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: vi.fn(),
}));

vi.mock("@/lib/db/reset", () => ({
  clearAllIndexedDbData: vi.fn(),
}));

import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { clearAllIndexedDbData } from "@/lib/db/reset";

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
  vi.mocked(clearAllIndexedDbData).mockReset();
  window.localStorage.clear();
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

  describe("言語設定", () => {
    it("デフォルト設定(学ぶ言語:English / 解説言語:日本語)を選択済みで表示する", () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);

      render(<SettingsPage />);

      expect(screen.getByLabelText("学ぶ言語")).toHaveValue("en");
      expect(screen.getByLabelText("解説言語")).toHaveValue("ja");
    });

    it("保存されていた設定を読み込んでセレクトに反映する", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ targetLang: "es", explainLang: "fr" }),
      );

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByLabelText("学ぶ言語")).toHaveValue("es");
      });
      expect(screen.getByLabelText("解説言語")).toHaveValue("fr");
    });

    it("保存されていた設定が壊れている場合は通知し、デフォルトに戻して表示する", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, "{ 壊れたJSON");

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByText(/保存されていた設定を読み込めなかったため/)).toBeInTheDocument();
      });
      expect(screen.getByLabelText("学ぶ言語")).toHaveValue("en");
    });

    it("言語ペアを変更して保存すると、LocalStorageに反映され保存完了メッセージが出る", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      const user = userEvent.setup();

      render(<SettingsPage />);

      await user.selectOptions(screen.getByLabelText("学ぶ言語"), "es");
      await user.selectOptions(screen.getByLabelText("解説言語"), "de");
      await user.click(screen.getByRole("button", { name: "保存する" }));

      expect(screen.getByText("設定を保存しました")).toBeInTheDocument();
      expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({
        targetLang: "es",
        explainLang: "de",
        autoExtraction: { enabled: false, strictness: "normal" },
      });
    });

    it("学ぶ言語と解説言語に同じ値を選ぶと保存前にエラーを表示し、保存しない", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      const user = userEvent.setup();

      render(<SettingsPage />);

      await user.selectOptions(screen.getByLabelText("解説言語"), "en"); // targetLangの初期値(en)と同じにする
      await user.click(screen.getByRole("button", { name: "保存する" }));

      expect(screen.getByText(/学ぶ言語と解説言語には異なる言語を指定してください/)).toBeInTheDocument();
      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    });
  });

  describe("自動抽出設定", () => {
    it("デフォルトでは無効、フィルタの厳しさは標準を選択済みで表示する", () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);

      render(<SettingsPage />);

      expect(screen.getByRole("switch", { name: "自動抽出を有効にする" })).not.toBeChecked();
      expect(screen.getByLabelText("フィルタの厳しさ")).toHaveValue("normal");
    });

    it("保存されていた自動抽出設定を読み込んでUIに反映する", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          targetLang: "en",
          explainLang: "ja",
          autoExtraction: { enabled: true, strictness: "loose" },
        }),
      );

      render(<SettingsPage />);

      await waitFor(() => {
        expect(screen.getByRole("switch", { name: "自動抽出を有効にする" })).toBeChecked();
      });
      expect(screen.getByLabelText("フィルタの厳しさ")).toHaveValue("loose");
    });

    it("自動抽出を有効にしてフィルタの厳しさを変更し保存すると、LocalStorageに反映される", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      const user = userEvent.setup();

      render(<SettingsPage />);

      await user.click(screen.getByRole("switch", { name: "自動抽出を有効にする" }));
      await user.selectOptions(screen.getByLabelText("フィルタの厳しさ"), "strict");
      await user.click(screen.getByRole("button", { name: "保存する" }));

      expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}")).toEqual({
        targetLang: "en",
        explainLang: "ja",
        autoExtraction: { enabled: true, strictness: "strict" },
      });
    });
  });

  describe("データ管理", () => {
    it("「データを全て削除する」ボタンを押しても、確認ダイアログが出るまでは削除処理を呼ばない", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      const user = userEvent.setup();

      render(<SettingsPage />);
      await user.click(screen.getByRole("button", { name: "データを全て削除する" }));

      expect(screen.getByText(/この操作は取り消せません/)).toBeInTheDocument();
      expect(clearAllIndexedDbData).not.toHaveBeenCalled();
    });

    it("確認ダイアログでキャンセルすると、削除処理を呼ばずダイアログが閉じる", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      const user = userEvent.setup();

      render(<SettingsPage />);
      await user.click(screen.getByRole("button", { name: "データを全て削除する" }));
      await user.click(screen.getByRole("button", { name: "キャンセル" }));

      expect(screen.queryByText(/この操作は取り消せません/)).not.toBeInTheDocument();
      expect(clearAllIndexedDbData).not.toHaveBeenCalled();
    });

    it("確認ダイアログで削除を確定すると、IndexedDBとLocalStorageの両方が削除され、設定がデフォルトに戻る", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      vi.mocked(clearAllIndexedDbData).mockResolvedValue(undefined);
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ targetLang: "es", explainLang: "de", autoExtraction: { enabled: true, strictness: "strict" } }),
      );
      const user = userEvent.setup();

      render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByLabelText("学ぶ言語")).toHaveValue("es");
      });

      await user.click(screen.getByRole("button", { name: "データを全て削除する" }));
      await user.click(screen.getByRole("button", { name: "削除する" }));

      await waitFor(() => {
        expect(clearAllIndexedDbData).toHaveBeenCalledTimes(1);
      });
      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
      expect(screen.getByText("データを全て削除しました")).toBeInTheDocument();
      expect(screen.getByLabelText("学ぶ言語")).toHaveValue("en");
      expect(screen.getByLabelText("解説言語")).toHaveValue("ja");
    });

    it("削除処理が失敗した場合はエラーメッセージを表示し、設定は保持する", async () => {
      vi.mocked(runBrowserDiagnosis).mockResolvedValue(readyDiagnosis);
      vi.mocked(clearAllIndexedDbData).mockRejectedValue(new Error("IndexedDBの削除に失敗しました"));
      window.localStorage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({ targetLang: "es", explainLang: "de", autoExtraction: { enabled: false, strictness: "normal" } }),
      );
      const user = userEvent.setup();

      render(<SettingsPage />);
      await waitFor(() => {
        expect(screen.getByLabelText("学ぶ言語")).toHaveValue("es");
      });

      await user.click(screen.getByRole("button", { name: "データを全て削除する" }));
      await user.click(screen.getByRole("button", { name: "削除する" }));

      await waitFor(() => {
        expect(within(screen.getByRole("dialog")).getByText("IndexedDBの削除に失敗しました")).toBeInTheDocument();
      });
      expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).not.toBeNull();
      expect(screen.getByLabelText("学ぶ言語")).toHaveValue("es");
    });
  });
});
