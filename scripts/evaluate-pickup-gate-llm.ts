/**
 * Pick up 候補に対する LLM 単独の採否判定を取得し、TypeSafe(Jev)の採否ゲートと比較するスクリプト(issue #123)。
 *
 * 人手でラベルを付けた「発言と候補の組」を読み、発言ごとにアプリと同じハイブリッド抽出(`pickUpExpressions`)を
 * OpenRouter 経由で実行する。注入した候補が抽出結果に残れば「採用」、残らなければ「不採用」とみなす。
 * プロンプト・後段フィルタ・候補との照合はアプリ本体のコードをそのまま使うため、アプリの実挙動と同じ採否になる。
 * そのうえで `scripts/evaluate-pickup-gate.ts` が書き出した Jev の判定結果と突き合わせ、
 * LLM 単独のラベルごとの除去率と、閾値ごとの Jev との一致度を標準出力へ JSON で出力する。
 *
 * 実行方法:
 *   npm run eval:gate-llm -- <OpenRouterのモデルID> eval-data/<ラベル付きの組>.jsonl eval-data/<Jevの判定結果>.jsonl eval-data/<LLMの判定結果の出力先>.jsonl
 * API キーは `.env.local` の `OPENROUTER_API_KEY` から読む。
 *
 * 注意: 発言の本文を OpenRouter へ外部送信する。標準出力・判定結果のファイルには本文を書かない。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { createPickupBaseSessionFactory, pickUpExpressions } from "@/lib/ai/pickup";
import { findExpressionCandidates } from "@/lib/ai/pickup-candidates";
import { createPromptJobQueue, createSessionPool } from "@/lib/ai/session-pool";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { type LabeledGatePair, labeledGatePairSchema } from "./lib/labeled-gate-pair";
import { summarizeAgreement, summarizeGateJudgments, summarizeLatencies } from "./lib/pickup-gate-stats";

const ENV_FILE_PATH = ".env.local";
/** Jev の判定を採否に変換するときに比較する閾値(`evaluate-pickup-gate.ts` と同じ) */
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
/** LLM の採否(採用 = 1、不採用 = 0)を除去率の集計関数に渡すための閾値。0 と 1 の間ならどの値でも同じ結果になる */
const LLM_KEEP_THRESHOLD = 0.5;

const jevResultSchema = z.object({ id: z.number(), idiomaticProbability: z.number() });

const [model, pairsPath, jevResultsPath, llmResultsPath] = process.argv.slice(2);
if (model === undefined || pairsPath === undefined || jevResultsPath === undefined || llmResultsPath === undefined) {
  throw new Error(
    "使い方: npm run eval:gate-llm -- <モデルID> eval-data/<ラベル付きの組>.jsonl eval-data/<Jevの判定結果>.jsonl eval-data/<出力先>.jsonl",
  );
}
if (existsSync(ENV_FILE_PATH)) {
  process.loadEnvFile(ENV_FILE_PATH);
}
const apiKey = process.env.OPENROUTER_API_KEY;
if (apiKey === undefined || apiKey === "") {
  throw new Error(`OPENROUTER_API_KEY が設定されていません(${ENV_FILE_PATH} に記述してください)`);
}

/** JSONL を読み、各行をスキーマで検証する。不正な行は行番号付きで即座に失敗させる */
function readJsonLines<T>(filePath: string, schema: z.ZodType<T>): T[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const parsed = schema.safeParse(JSON.parse(line));
      if (!parsed.success) {
        throw new Error(`${filePath}:${index + 1} がスキーマに合いません: ${parsed.error.message}`);
      }
      return parsed.data;
    });
}

const pairs: LabeledGatePair[] = readJsonLines(pairsPath, labeledGatePairSchema);
const jevProbabilityById = new Map(
  readJsonLines(jevResultsPath, jevResultSchema).map((result) => [result.id, result.idiomaticProbability]),
);

const pairsByMessage = new Map<string, LabeledGatePair[]>();
for (const pair of pairs) {
  const messageKey = `${pair.source}\n${pair.text}`;
  pairsByMessage.set(messageKey, [...(pairsByMessage.get(messageKey) ?? []), pair]);
}

// 学ぶ言語は en、意味を書く言語は ja(アプリの主な利用形態)。配信の文脈(タイトル・カテゴリ)は収集していないため渡さない
const sessionPool = createSessionPool({
  createBaseSession: createPickupBaseSessionFactory(
    { ...DEFAULT_SETTINGS, llmProvider: "openrouter", openRouterApiKey: apiKey, openRouterModel: model },
    "en",
    "ja",
  ),
  queue: createPromptJobQueue(),
});

interface LlmResult {
  id: number;
  expressionKey: string;
  label: LabeledGatePair["label"];
  llmKeeps: boolean;
}

const llmResults: LlmResult[] = [];
const requestLatenciesMs: number[] = [];
/** 抽出がエラーになった発言数(アプリでは何も表示されない。採否を決められないため一致度の集計から除く) */
let failedMessageCount = 0;
for (const messagePairs of pairsByMessage.values()) {
  const startedAt = performance.now();
  let adoptedTerms: Set<string>;
  try {
    const result = await pickUpExpressions(sessionPool, messagePairs[0].text, {
      findCandidates: (preparedText) => findExpressionCandidates(preparedText, "en"),
    });
    adoptedTerms = new Set(result.terms.map((term) => term.term));
  } catch {
    // スキーマ不一致・本文に無い語句の返却など、アプリでも表示に至らない失敗。件数だけ数えて次の発言へ進む
    failedMessageCount += 1;
    continue;
  }
  requestLatenciesMs.push(performance.now() - startedAt);
  for (const pair of messagePairs) {
    // 採用された候補の語句は `pickUpExpressions` が候補の表面形に置き換えて返すため、表面形の一致で採用を判定できる
    llmResults.push({
      id: pair.id,
      expressionKey: pair.expressionKey,
      label: pair.label,
      llmKeeps: adoptedTerms.has(pair.term),
    });
  }
}
sessionPool.dispose();

writeFileSync(llmResultsPath, `${llmResults.map((result) => JSON.stringify(result)).join("\n")}\n`);

process.stdout.write(
  `${JSON.stringify(
    {
      model,
      candidateCount: llmResults.length,
      failedMessageCount,
      latencyPerMessage: summarizeLatencies(requestLatenciesMs),
      llmAlone: summarizeGateJudgments(
        llmResults.map((result) => ({ ...result, idiomaticProbability: result.llmKeeps ? 1 : 0 })),
        LLM_KEEP_THRESHOLD,
      ),
      agreementWithJevByThreshold: THRESHOLDS.map((threshold) => ({
        threshold,
        ...summarizeAgreement(
          llmResults.map((result) => {
            const probability = jevProbabilityById.get(result.id);
            if (probability === undefined) {
              throw new Error(`Jev の判定結果に候補 ${result.id} がありません`);
            }
            return { gateKeeps: probability >= threshold, llmKeeps: result.llmKeeps };
          }),
        ),
      })),
    },
    null,
    2,
  )}\n`,
);
