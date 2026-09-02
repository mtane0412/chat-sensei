/**
 * src/components/language-pair-select.tsx(言語ペアの常時表示セレクト)のテスト。
 *
 * チャンネル接続フォームの横に常時表示する「学ぶ言語」「解説言語」の2つのセレクトを検証する。
 * ファーストビューで「どのチャンネルに接続して、何の言語をどの言語で学んでいるか」が
 * 見えるようにするため、ダイアログではなくインラインのセレクトにしている。
 *
 * - 変更は即座に `useSettingsStore.setSettings`(→ LocalStorage)へ保存される
 * - 学ぶ言語と解説言語が同じペアはスキーマで禁止されているため、もう一方と同じ言語を
 *   選んだ場合は両者を入れ替えて保存する(翻訳ツールの言語スワップと同じ挙動)
 * - ストアが LocalStorage から未復元の間は無効化し、復元前の保存事故を防ぐ
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from "@/lib/settings";
import { hydrateSettingsStore, resetSettingsStoreForTests, useSettingsStore } from "@/store/settings";
import { LanguagePairSelect } from "./language-pair-select";

beforeEach(() => {
  resetSettingsStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("LanguagePairSelect", () => {
  it("学ぶ言語・解説言語のセレクトを現在の設定値で表示する", () => {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ learningLang: "es", explainLang: "en" }));
    hydrateSettingsStore();

    render(<LanguagePairSelect />);

    expect(screen.getByRole("combobox", { name: "Learning language" })).toHaveValue("es");
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toHaveValue("en");
  });

  it("ストアが未復元の間はセレクトを無効化する(復元前にデフォルト値で保存してしまう事故を防ぐ)", () => {
    render(<LanguagePairSelect />);

    expect(screen.getByRole("combobox", { name: "Learning language" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toBeDisabled();
  });

  it("学ぶ言語を変更すると、ストアと LocalStorage に即座に保存される", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LanguagePairSelect />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Learning language" }), "de");

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "de", explainLang: "ja" });
    expect(JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "null")).toEqual({
      ...DEFAULT_SETTINGS,
      learningLang: "de",
      explainLang: "ja",
    });
  });

  it("解説言語を変更すると、ストアに即座に保存される", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LanguagePairSelect />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Explanation language" }), "fr");

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "en", explainLang: "fr" });
  });

  it("学ぶ言語に解説言語と同じ言語を選ぶと、両者を入れ替えて保存する(同じペアはスキーマで禁止のため)", async () => {
    // 既定(英語を学ぶ / 日本語で解説)で、学ぶ言語に日本語を選ぶ → 「日本語を学ぶ / 英語で解説」になる
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LanguagePairSelect />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Learning language" }), "ja");

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "ja", explainLang: "en" });
    expect(screen.getByRole("combobox", { name: "Learning language" })).toHaveValue("ja");
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toHaveValue("en");
  });

  it("解説言語に学ぶ言語と同じ言語を選んだ場合も、両者を入れ替えて保存する", async () => {
    const user = userEvent.setup();
    hydrateSettingsStore();
    render(<LanguagePairSelect />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Explanation language" }), "en");

    expect(useSettingsStore.getState().settings).toEqual({ ...DEFAULT_SETTINGS, learningLang: "ja", explainLang: "en" });
  });

  it("各セレクトにはサポートする5言語がネイティブ表記で並ぶ", () => {
    hydrateSettingsStore();
    render(<LanguagePairSelect />);

    const learningSelect = screen.getByRole("combobox", { name: "Learning language" });
    for (const label of ["English", "日本語", "Español", "Deutsch", "Français"]) {
      expect(learningSelect).toContainElement(screen.getAllByRole("option", { name: label })[0]);
    }
  });
});
