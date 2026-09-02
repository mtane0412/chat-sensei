/**
 * src/components/site-header.tsx のテスト。
 *
 * 全ページ共通ヘッダーが、アプリ名をホームへのリンクとして描画し、
 * 右側に言語ペアのセレクト(コンパクト表示)と設定ダイアログのトリガーを
 * 表示することを検証する(接続前後のどちらでも設定に触れるようにするため)。
 * 設定ダイアログの環境診断(`runBrowserDiagnosis`)はブラウザ API に触れるためモックする。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { resetSettingsStoreForTests } from "@/store/settings";
import { SiteHeader } from "./site-header";

vi.mock("@/lib/ai/runBrowserDiagnosis", () => ({
  runBrowserDiagnosis: () => new Promise(() => {}),
}));

afterEach(() => {
  resetSettingsStoreForTests();
  window.localStorage.clear();
});

describe("SiteHeader", () => {
  it("アプリ名(chat-sensei)をホームへのリンクとして表示する", () => {
    render(<SiteHeader />);

    const homeLink = screen.getByRole("link", { name: "chat-sensei" });
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("ヘッダー右側に言語ペアのセレクト(学ぶ言語 / 解説言語)を表示する", () => {
    render(<SiteHeader />);

    expect(screen.getByRole("combobox", { name: "Learning language" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Explanation language" })).toBeInTheDocument();
  });

  it("ヘッダー右側に設定ダイアログを開くボタンを表示する", () => {
    render(<SiteHeader />);

    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
