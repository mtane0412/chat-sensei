/**
 * Pick up 候補生成を実チャットログで評価するスクリプト(issue #117)。
 *
 * `scripts/collect-chat-log.ts` が収集した JSONL を読み、各発言にアプリと同じ候補生成器
 * (`findExpressionCandidates`)を適用して、1発言あたりの候補件数の分布・注入上限ごとの超過件数・
 * 頻出表現・クールダウンのシミュレーション結果を標準出力へ JSON で出力する。
 *
 * 実行方法(`scripts/run-ts-script.mjs` が `@/` エイリアス付きで実行する):
 *   npm run eval:candidates -- eval-data/<ファイル名>.jsonl [...]
 * 複数ファイルを指定した場合は、ファイルごとに別の配信として集計する
 * (クールダウンのシミュレーションを配信間で持ち越さないため)。
 *
 * 出力に含まれる文字列は表現リスト由来の表現キーだけで、チャットの本文は出力しない。
 */
import { readFileSync } from "node:fs";
import { findExpressionCandidates } from "@/lib/ai/pickup-candidates";
import { PICKUP_ENCOUNTER_COOLDOWN_MS } from "@/store/pickup-encounters";
import { collectedChatMessageSchema } from "./lib/collected-chat-message";
import { type CandidateObservation, summarizeCandidateObservations } from "./lib/pickup-candidate-stats";

/** 比較する注入件数の上限の候補(issue #117 のタスク「上限(8〜12件)を確定する」に対応。小さい側は参考値) */
const INJECTION_LIMITS = [3, 5, 8, 10, 12];
/** 頻出表現を上位何件まで出力するか */
const TOP_EXPRESSION_COUNT = 40;

/** JSONL ファイルを読み、発言ごとの候補を観測データに変換する。不正な行は行番号付きで即座に失敗させる */
function loadObservations(filePath: string): CandidateObservation[] {
  const lines = readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      // JSON として壊れた行(収集の中断で途中まで書かれた行など)も、どの行かが分かる形で失敗させる
      throw new Error(`${filePath}:${index + 1} を JSON として解釈できません`, { cause: error });
    }
    const parsed = collectedChatMessageSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error(`${filePath}:${index + 1} の形式が不正です: ${parsed.error.message}`);
    }
    return {
      timestampMs: parsed.data.timestampMs,
      expressionKeys: findExpressionCandidates(parsed.data.text, "en").map((candidate) => candidate.expressionKey),
    };
  });
}

const filePaths = process.argv.slice(2);
if (filePaths.length === 0) {
  throw new Error("評価するログを指定してください: npm run eval:candidates -- eval-data/<ファイル名>.jsonl [...]");
}

for (const filePath of filePaths) {
  const stats = summarizeCandidateObservations(loadObservations(filePath), {
    injectionLimits: INJECTION_LIMITS,
    cooldownMs: PICKUP_ENCOUNTER_COOLDOWN_MS,
    topExpressionCount: TOP_EXPRESSION_COUNT,
  });
  process.stdout.write(`${JSON.stringify({ file: filePath, ...stats }, null, 2)}\n`);
}
