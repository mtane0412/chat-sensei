/**
 * src/components/explanation-result-view.tsx(解説結果の表示)のテスト。
 *
 * `explanationSchema` の各要素(訳・直訳・注目語句・難易度)が日本語ラベル付きで
 * 表示されること、注目語句が無い場合はその見出しを出さないことを検証する。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ExplanationResult } from "@/lib/ai/schemas";
import { ExplanationResultView } from "./explanation-result-view";

const サンプル解説: ExplanationResult = {
  translation: "ナイスゲーム、チャットのみんな",
  literal: "良いゲーム、チャット",
  items: [
    { term: "gg", kind: "abbreviation", meaning: "good game の略", note: "試合終了時の定番の挨拶" },
    { term: "chat", kind: "slang", meaning: "視聴者全体への呼びかけ", note: "配信者が視聴者をまとめて呼ぶ言い方" },
  ],
  difficulty: 2,
};

describe("ExplanationResultView", () => {
  it("訳・直訳・難易度を表示する", () => {
    render(<ExplanationResultView result={サンプル解説} />);

    expect(screen.getByText("ナイスゲーム、チャットのみんな")).toBeInTheDocument();
    expect(screen.getByText("良いゲーム、チャット")).toBeInTheDocument();
    expect(screen.getByText("難易度 2/5")).toBeInTheDocument();
  });

  it("注目語句を語句・分類(日本語ラベル)・意味・メモ付きで列挙する", () => {
    render(<ExplanationResultView result={サンプル解説} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("gg");
    expect(items[0]).toHaveTextContent("略語");
    expect(items[0]).toHaveTextContent("good game の略");
    expect(items[0]).toHaveTextContent("試合終了時の定番の挨拶");
    expect(items[1]).toHaveTextContent("スラング");
  });

  it("注目語句が無い場合は見出しもリストも表示しない", () => {
    render(<ExplanationResultView result={{ ...サンプル解説, items: [] }} />);

    expect(screen.queryByText("注目ポイント")).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });
});
