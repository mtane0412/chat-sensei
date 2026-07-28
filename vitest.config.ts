/**
 * Vitest 設定ファイル。
 *
 * jsdom 環境でクライアントサイド専用の chat-sensei をテストする。
 * `@/` エイリアスは tsconfig.json の paths 設定と一致させている。
 * setupFiles では fake-indexeddb と Testing Library の jest-dom マッチャーを登録する。
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    globals: true,
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/components/ui/**", "src/**/*.d.ts"],
    },
  },
});
