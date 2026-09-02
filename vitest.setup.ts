/**
 * Vitest のグローバルセットアップ。
 *
 * - Testing Library の jest-dom マッチャーを追加する
 * - LocalStorage は jsdom 標準で利用可能なため追加設定は不要
 * - jsdom の Range には getBoundingClientRect が無いため、ゼロ矩形を返すスタブを足す
 *   (手動Pick upの選択UIが使う。本番コードにテスト環境向けのフォールバックを持ち込まないため、ここで補う)
 */
import "@testing-library/jest-dom/vitest";

if (typeof Range !== "undefined" && typeof Range.prototype.getBoundingClientRect !== "function") {
  Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
}
