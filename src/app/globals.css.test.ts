/**
 * src/app/globals.css のデザイントークンのテスト(issue #87)。
 *
 * Twitch ライクなダークファーストのデザイントークンが定義されていることを、
 * CSS ファイルのテキストとして検証する(jsdom は CSS カスタムプロパティの
 * カスケードを解決しないため、ファイル内容ベースで仕様を固定する)。
 *
 * - `:root` が紫みを帯びたダークパレット(Ground / Surface / Violet)を持つこと
 * - Pick up 語句の強調用トークン `--pickup`(ゴールド)が定義され、
 *   Tailwind のユーティリティ(text-pickup 等)として使えるよう @theme に対応付くこと
 * - 角丸が小さめ(0.5rem)に調整されていること
 * - 見出しフォントが Sora(--font-sora。layout.tsx で next/font が注入する)に対応付くこと
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** `:root { ... }` ブロックの中身だけを取り出す(`.dark` ブロックと区別して検証するため) */
function rootBlock(): string {
  const match = css.match(/:root \{([^}]*)\}/);
  if (match === null) throw new Error("globals.css に :root ブロックがありません");
  return match[1];
}

describe("globals.css のデザイントークン(Twitch ライクなダークファースト)", () => {
  it(":root の背景が紫みを帯びたダーク(Ground)である", () => {
    expect(rootBlock()).toContain("--background: oklch(0.166 0.01 285.21)");
  });

  it(":root のカード面が Ground より一段明るい Surface である", () => {
    expect(rootBlock()).toContain("--card: oklch(0.208 0.016 284.95)");
  });

  it(":root のプライマリがバイオレットのアクセントである", () => {
    expect(rootBlock()).toContain("--primary: oklch(0.709 0.159 293.54)");
  });

  it(":root に Pick up 語句の強調用トークン --pickup(ゴールド)が定義されている", () => {
    expect(rootBlock()).toContain("--pickup: oklch(0.824 0.141 70.17)");
  });

  it("--pickup が Tailwind のカラーとして使えるよう @theme に対応付いている", () => {
    expect(css).toContain("--color-pickup: var(--pickup)");
  });

  it("角丸が小さめ(0.5rem)に調整されている", () => {
    expect(rootBlock()).toContain("--radius: 0.5rem");
  });

  it("見出しフォントが Sora(--font-sora)に対応付いている", () => {
    expect(css).toContain("--font-heading: var(--font-sora)");
  });

  it("視聴者数などの --live トークンがダーク背景で読める明るめの赤のまま維持されている", () => {
    expect(rootBlock()).toContain("--live: oklch(0.704 0.191 22.216)");
  });
});
