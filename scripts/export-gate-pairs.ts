/**
 * 採否ゲートの比較検証(issue #123)用に、候補が出た発言と候補の組を書き出すスクリプト。
 *
 * `scripts/collect-chat-log.ts` が収集した JSONL を読み、各発言にアプリと同じ候補生成器
 * (`findExpressionCandidates`)を適用して、1候補を1行とする JSONL を書き出す。
 * 書き出したファイルの各行に人手で `label`(literal / basic / valuable)を付けると、
 * `scripts/evaluate-pickup-gate.ts` の入力になる。
 *
 * 実行方法:
 *   npm run eval:gate-pairs -- <出力先.jsonl> eval-data/<ログ>.jsonl [...]
 *
 * 出力には本文が含まれるため、出力先は gitignore 済みの `eval-data/` 配下だけを許可する。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { findExpressionCandidates } from "@/lib/ai/pickup-candidates";
import { collectedChatMessageSchema } from "./lib/collected-chat-message";
import type { GatePair } from "./lib/labeled-gate-pair";

/** 本文を含むファイルの置き場所(gitignore 済み) */
const EVAL_DATA_DIRECTORY = "eval-data";
/** 収集ログのファイル名の末尾に付く収集開始日時(例: `-2026-09-18T12-32-57-086Z.jsonl`) */
const LOG_TIMESTAMP_SUFFIX = /-\d{4}-\d{2}-\d{2}T[\d-]+Z\.jsonl$/;

const [outputPath, ...logPaths] = process.argv.slice(2);
if (outputPath === undefined || logPaths.length === 0) {
  throw new Error("使い方: npm run eval:gate-pairs -- <出力先.jsonl> eval-data/<ログ>.jsonl [...]");
}
// 本文入りのファイルを誤ってコミット対象の場所へ書かないよう、出力先を eval-data/ 配下に限定する
const relativeOutputPath = path.relative(path.resolve(EVAL_DATA_DIRECTORY), path.resolve(outputPath));
if (relativeOutputPath.startsWith("..") || path.isAbsolute(relativeOutputPath)) {
  throw new Error(`出力先は ${EVAL_DATA_DIRECTORY}/ 配下を指定してください: ${outputPath}`);
}

const pairs: GatePair[] = [];
for (const logPath of logPaths) {
  // 収集ログのファイル名は `<チャンネル名>-<日時>.jsonl` なので、末尾の日時だけを外して収集元の名前にする
  // (名前にハイフンを含む収集元どうしが同じ名前に潰れないよう、最初のハイフンでは切らない)
  const source = path.basename(logPath).replace(LOG_TIMESTAMP_SUFFIX, "");
  const lines = readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  lines.forEach((line, index) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new Error(`${logPath}:${index + 1} を JSON として解釈できません`, { cause: error });
    }
    const message = collectedChatMessageSchema.parse(json);
    for (const candidate of findExpressionCandidates(message.text, "en")) {
      pairs.push({
        id: pairs.length,
        source,
        text: message.text,
        term: candidate.term,
        expressionKey: candidate.expressionKey,
      });
    }
  });
}

writeFileSync(outputPath, `${pairs.map((pair) => JSON.stringify(pair)).join("\n")}\n`);
process.stdout.write(
  `${JSON.stringify({ outputPath, pairCount: pairs.length, distinctExpressionCount: new Set(pairs.map((pair) => pair.expressionKey)).size })}\n`,
);
