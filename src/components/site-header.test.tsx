/**
 * src/components/site-header.tsx のテスト。
 *
 * 全ページ共通ヘッダーが、アプリ名をホームへのリンクとして描画することを検証する。
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
});
