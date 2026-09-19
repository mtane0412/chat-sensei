/**
 * `scripts/` 配下の TypeScript スクリプトを、アプリ本体と同じ `@/` エイリアス(→ `src/`)付きで実行するランチャー。
 *
 * 評価用スクリプト(issue #117)は `src/` のモジュールをそのまま再利用するが、それらは `@/` エイリアスや
 * 拡張子なしの相対 import を使っており Node 単体では解決できないため、jiti で読み込む。
 *
 * 実行方法:
 *   node scripts/run-ts-script.mjs <スクリプトのパス> [スクリプトへ渡す引数...]
 * 実行されるスクリプトからは、引数が `process.argv.slice(2)` で(スクリプトのパスを除いて)見える。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [scriptPath] = process.argv.slice(2);
if (scriptPath === undefined) {
  throw new Error("実行するスクリプトのパスを指定してください: node scripts/run-ts-script.mjs <スクリプトのパス>");
}
// ランチャー自身への引数(スクリプトのパス)を取り除き、スクリプトには自分宛ての引数だけを見せる
process.argv.splice(2, 1);

const jiti = createJiti(import.meta.url, { alias: { "@": path.join(repositoryRoot, "src") } });
await jiti.import(path.resolve(scriptPath));
