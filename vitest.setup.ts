/**
 * Vitest のグローバルセットアップ。
 *
 * - fake-indexeddb で IndexedDB(Dexie)をテスト環境にポリフィルする
 * - Testing Library の jest-dom マッチャーを追加する
 * - LocalStorage は jsdom 標準で利用可能なため追加設定は不要
 */
import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
