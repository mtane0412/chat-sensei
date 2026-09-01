/**
 * src/components/language-dialogs.tsx(列見出しから開く言語設定ダイアログ)のテスト。
 *
 * - `LearningLanguagesDialog`: 生IRC列の見出しから開き、学ぶ言語(翻訳・Pick up の対象にする原文の言語)を
 *   チェックボックスで複数選んで保存する。1つも選ばずに保存しようとするとエラーを表示して保存しない
 * - `ExplanationLanguageDialog`: 翻訳列の見出しから開き、解説言語(訳文・Pick up の意味の言語)をセレクトで選んで保存する
 *
 * 設定の正本は settings ストア(LocalStorage 連携)にあるため、ストアと LocalStorage の両方を確認する。
 * 学ぶ言語と解説言語が同じ組み合わせは禁止しない(同じ言語の発言はパイプライン側でスキップする)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "@/lib/settings";
import { hydrateSettingsStore, resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";
import { ExplanationLanguageDialog, LearningLanguagesDialog } from "./language-dialogs";

beforeEach(() => {
  resetSettingsStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("LearningLanguagesDialog", () => {
  it("ストアが LocalStorage から未復元の間は、ボタンを無効にして開けないようにする(デフォルト設定で上書きしないため)", () => {
    render(<LearningLanguagesDialog />);

    expect(screen.getByRole("button", { name: "Learning languages" })).toBeDisabled();
  });

  it("開くと、対応 5 言語のチェックボックスに現在の学ぶ言語が反映されている", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    useSettingsStore.getState().setSettings({ learningLangs: ["en", "ja"], explainLang: "ja" });
    render(<LearningLanguagesDialog />);

    await user.click(screen.getByRole("button", { name: "Learning languages" }));
    const dialog = await screen.findByRole("dialog", { name: "Learning languages" });

    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(5);
    expect(within(dialog).getByRole("checkbox", { name: "English" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "日本語" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "Español" })).not.toBeChecked();
  });

  it("チェックを変えて保存すると、学ぶ言語だけを更新して LocalStorage にも保存し、ダイアログを閉じる", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LearningLanguagesDialog />);

    await user.click(screen.getByRole("button", { name: "Learning languages" }));
    const dialog = await screen.findByRole("dialog", { name: "Learning languages" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Español" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["en", "es"], explainLang: "ja" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      learningLangs: ["en", "es"],
      explainLang: "ja",
    });
    expect(screen.queryByRole("dialog", { name: "Learning languages" })).not.toBeInTheDocument();
  });

  it("1 つも選ばずに保存しようとするとエラーを表示し、保存しない", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LearningLanguagesDialog />);

    await user.click(screen.getByRole("button", { name: "Learning languages" }));
    const dialog = await screen.findByRole("dialog", { name: "Learning languages" });
    await user.click(within(dialog).getByRole("checkbox", { name: "English" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(within(dialog).getByRole("alert")).toHaveTextContent(/at least one/);
    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(window.localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("キャンセルすると変更を捨て、次に開いたときはストアの値に戻っている", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LearningLanguagesDialog />);

    await user.click(screen.getByRole("button", { name: "Learning languages" }));
    let dialog = await screen.findByRole("dialog", { name: "Learning languages" });
    await user.click(within(dialog).getByRole("checkbox", { name: "Deutsch" }));
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(useSettingsStore.getState().settings).toEqual(DEFAULT_SETTINGS);
    await user.click(screen.getByRole("button", { name: "Learning languages" }));
    dialog = await screen.findByRole("dialog", { name: "Learning languages" });
    expect(within(dialog).getByRole("checkbox", { name: "Deutsch" })).not.toBeChecked();
  });
});

describe("ExplanationLanguageDialog", () => {
  it("ストアが LocalStorage から未復元の間は、ボタンを無効にして開けないようにする", () => {
    render(<ExplanationLanguageDialog />);

    expect(screen.getByRole("button", { name: "Explanation language" })).toBeDisabled();
  });

  it("開くと、セレクトに現在の解説言語が入っている", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    useSettingsStore.getState().setSettings({ learningLangs: ["es"], explainLang: "en" });
    render(<ExplanationLanguageDialog />);

    await user.click(screen.getByRole("button", { name: "Explanation language" }));
    const dialog = await screen.findByRole("dialog", { name: "Explanation language" });

    expect(within(dialog).getByRole("combobox", { name: "Explanation language" })).toHaveValue("en");
  });

  it("言語を変えて保存すると、解説言語だけを更新して LocalStorage にも保存し、ダイアログを閉じる", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    useSettingsStore.getState().setSettings({ learningLangs: ["en", "fr"], explainLang: "ja" });
    render(<ExplanationLanguageDialog />);

    await user.click(screen.getByRole("button", { name: "Explanation language" }));
    const dialog = await screen.findByRole("dialog", { name: "Explanation language" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Explanation language" }), "de");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["en", "fr"], explainLang: "de" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      learningLangs: ["en", "fr"],
      explainLang: "de",
    });
    expect(screen.queryByRole("dialog", { name: "Explanation language" })).not.toBeInTheDocument();
  });

  it("学ぶ言語と同じ言語を解説言語に選んでも保存できる(同じ言語の発言はパイプライン側でスキップする)", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<ExplanationLanguageDialog />);

    await user.click(screen.getByRole("button", { name: "Explanation language" }));
    const dialog = await screen.findByRole("dialog", { name: "Explanation language" });
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Explanation language" }), "en");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(useSettingsStore.getState().settings).toEqual({ learningLangs: ["en"], explainLang: "en" });
  });
});
