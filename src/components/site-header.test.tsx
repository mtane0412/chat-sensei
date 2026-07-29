/**
 * src/components/site-header.tsx のテスト。
 *
 * 全ページ共通ヘッダーが、アプリ名とナビゲーションリンクを正しく描画することを検証する。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SiteHeader } from "./site-header";

describe("SiteHeader", () => {
  it("アプリ名(chat-sensei)をホームへのリンクとして表示する", () => {
    render(<SiteHeader />);

    const homeLink = screen.getByRole("link", { name: "chat-sensei" });
    expect(homeLink).toHaveAttribute("href", "/");
  });

  it("設定ページへのリンクを表示する", () => {
    render(<SiteHeader />);

    const settingsLink = screen.getByRole("link", { name: "設定" });
    expect(settingsLink).toHaveAttribute("href", "/settings");
  });

  it("単語帳ページ(/deck)へのリンクを表示する", () => {
    render(<SiteHeader />);

    const deckLink = screen.getByRole("link", { name: "単語帳" });
    expect(deckLink).toHaveAttribute("href", "/deck");
  });
});
