/**
 * src/components/settings-dialog.tsx(設定ダイアログ)のテスト。
 *
 * ホーム画面の接続フォーム横のアイコンから開き、言語ペア(学ぶ言語 / 解説言語)の変更・保存、
 * 保存データが壊れていた場合の通知、Prompt API の環境診断結果の表示、設定の初期化ができることを検証する。
 * 言語ペアの正本は settings ストア(LocalStorage 連携)にあるため、ストアと LocalStorage の両方を確認する。
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
  await user.click(screen.getByRole("button", { name: "設定" }));
  return screen.findByRole("dialog", { name: "設定" });
}

describe("SettingsDialog(言語ペア)", () => {
  it("ストアが LocalStorage から未復元の間は、設定ボタンを無効にして開けないようにする(デフォルト設定で上書きしないため)", () => {
    render(<SettingsDialog />);

    expect(screen.getByRole("button", { name: "設定" })).toBeDisabled();
  });

  it("設定ボタンから開くと、学ぶ言語・解説言語のセレクトに現在の設定が入っている", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    useSettingsStore.getState().setSettings({ targetLang: "es", explainLang: "en" });
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByRole("combobox", { name: "学ぶ言語" })).toHaveValue("es");
    expect(within(dialog).getByRole("combobox", { name: "解説言語" })).toHaveValue("en");
  });

  it("言語ペアを変更して保存すると、ストアに反映され LocalStorage にも保存され、ダイアログが閉じる", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "学ぶ言語" }), "de");
    await user.click(within(dialog).getByRole("button", { name: "保存する" }));

    expect(useSettingsStore.getState().settings).toEqual({ targetLang: "de", explainLang: "ja" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      targetLang: "de",
      explainLang: "ja",
    });
    expect(screen.queryByRole("dialog", { name: "設定" })).not.toBeInTheDocument();
  });

  it("学ぶ言語と解説言語に同じ言語を選んで保存するとエラーを表示し、保存しない", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "学ぶ言語" }), "ja");
    await user.click(within(dialog).getByRole("button", { name: "保存する" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent("異なる言語を指定してください");
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(screen.getByRole("dialog", { name: "設定" })).toBeInTheDocument();
  });

  it("保存データが壊れていた場合は、デフォルトに戻した旨を表示する", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, "壊れたデータ");
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText(/デフォルトに戻しました/)).toBeInTheDocument();
  });

  it("「設定を初期化する」で LocalStorage の設定を削除し、セレクトもデフォルトに戻る", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ targetLang: "fr", explainLang: "en" }));
    hydrateSettingsStore();
    render(<SettingsDialog />);

    const dialog = await openDialog(user);
    await user.click(within(dialog).getByRole("button", { name: "設定を初期化する" }));

    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(within(dialog).getByRole("combobox", { name: "学ぶ言語" })).toHaveValue("en");
    expect(within(dialog).getByRole("combobox", { name: "解説言語" })).toHaveValue("ja");
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
      expect.stringContaining("Prompt API はすぐに利用できます"),
      expect.stringContaining("Language Detector API は利用可能です"),
      expect.stringContaining("約10.0GB"),
    ]);
  });

  it("診断が完了するまでは「診断中...」と表示する", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    mockRunBrowserDiagnosis.mockReturnValue(new Promise(() => {}));
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(within(dialog).getByText("診断中...")).toBeInTheDocument();
  });

  it("診断そのものが失敗した場合は理由を表示する(暗黙に利用可能扱いにしない)", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    mockRunBrowserDiagnosis.mockRejectedValue(new Error("LanguageModel.availability がクラッシュしました"));
    render(<SettingsDialog />);

    const dialog = await openDialog(user);

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "環境診断に失敗しました: LanguageModel.availability がクラッシュしました",
    );
  });
});
