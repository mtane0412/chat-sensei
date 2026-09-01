/**
 * src/components/settings-dialog.tsx(設定ダイアログ)のテスト。
 *
 * ホーム画面の接続フォーム横のアイコンから開き、保存データが壊れていた場合の通知、
 * Prompt API / Language Detector の環境診断結果の表示、設定の初期化ができることを検証する。
 * 言語設定(学ぶ言語 / 解説言語)は各列の見出しのダイアログ(`language-dialogs.tsx`)に移したため、ここでは扱わない。
 * 環境診断(`runBrowserDiagnosis`)はブラウザ API に触れるためモックする。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "@/lib/settings";
import { hydrateSettingsStore, resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";

const mockRunBrowserDiagnosis = vi.fn<() => Promise<EnvironmentDiagnosis>>();

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: () => mockRunBrowserDiagnosis(),
}));

import { SettingsDialog } from "./settings-dialog";

/** Prompt API がすぐに使える環境(Chrome 150)の診断結果 */
const 利用可能な診断結果: EnvironmentDiagnosis = {
  chromeVersion: 150,
  meetsMinimumChromeVersion: true,
  languageModel: { supported: true, availability: "available" },
  languageDetector: { supported: true, availability: "available" },
  storageEstimate: { quota: 10 * 1024 * 1024 * 1024, usage: 0 },
  overallReady: true,
};

beforeEach(() => {
  resetSettingsStoreForTests();
  mockRunBrowserDiagnosis.mockReset();
  mockRunBrowserDiagnosis.mockResolvedValue(利用可能な診断結果);
});

afterEach(() => {
  window.localStorage.clear();
});

/** ダイアログを開き、ダイアログ要素を返す */
async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Settings" }));
  return screen.findByRole("dialog", { name: "Settings" });
}

describe("SettingsDialog(設定の初期化・通知)", () => {
  it("ストアが LocalStorage から未復元の間は、設定ボタンを無効にして開けないようにする(初期化でデフォルトを書き込まないため)", () => {
    render(<SettingsDialog />);

    expect(screen.getByRole("button", { name: "Settings" })).toBeDisabled();
  });

  it("言語設定のセレクトは置かない(学ぶ言語・解説言語は各列の見出しから設定する)", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
  });

  it("保存データが壊れていた場合は、デフォルトに戻した旨を表示する", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(/reset to the defaults/)).toBeInTheDocument();
  });

  it("「設定を初期化する」で LocalStorage の設定を削除し、ストアもデフォルトに戻る", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLangs: ["fr"], explainLang: "en" }));
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "Reset settings" }));

    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe("SettingsDialog(環境診断)", () => {
  it("開くと環境診断を実行し、Chrome バージョン・Prompt API・Language Detector・ストレージの結果を表示する", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(mockRunBrowserDiagnosis).toHaveBeenCalledTimes(1);
    const items = await within(dialog).findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Chrome 150"),
      expect.stringContaining("The Prompt API is ready to use"),
      expect.stringContaining("The Language Detector API is ready to use"),
      expect.stringContaining("about 10.0GB"),
    ]);
  });

  it("診断が完了するまでは「診断中...」と表示する", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    mockRunBrowserDiagnosis.mockReturnValue(new Promise(() => {}));
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText("Checking...")).toBeInTheDocument();
  });

  it("診断そのものが失敗した場合は理由を表示する(暗黙に利用可能扱いにしない)", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    mockRunBrowserDiagnosis.mockRejectedValue(new Error("LanguageModel.availability がクラッシュしました"));
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Environment check failed: LanguageModel.availability がクラッシュしました",
    );
  });
});
