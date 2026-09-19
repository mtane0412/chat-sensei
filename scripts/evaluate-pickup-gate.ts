/**
 * Pick up 候補の採否ゲートとして TypeSafe(Jev)を評価するスクリプト(issue #123)。
 *
 * 人手でラベルを付けた「発言と候補の組」(`scripts/export-gate-pairs.ts` の出力にラベルを付けたもの)を読み、
 * 候補ごとに「本文中で慣用表現として使われているか」を Jev の Noul(yes の確率)で判定させて、
 * 閾値ごとの除去率・誤除去率と、1発言あたりの追加時間を標準出力へ JSON で出力する。
 * 同じ発言の候補は、アプリに組み込む場合と同じく1リクエストの複数質問としてまとめて送る。
 *
 * 実行方法:
 *   npm run eval:gate -- eval-data/<ラベル付きの組>.jsonl eval-data/<判定結果の出力先>.jsonl
 * API キーは `.env.local` の `TYPESAFE_API_KEY` から読む。
 *
 * 注意: 発言の本文を TypeSafe へ外部送信する。標準出力に含まれる文字列は表現キーだけで、本文は出力しない。
 * 判定結果のファイルにも本文は書かない(通し番号・表現キー・ラベル・確率・所要時間だけ)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { type LabeledGatePair, labeledGatePairSchema } from "./lib/labeled-gate-pair";
import { type GateJudgment, summarizeGateJudgments, summarizeLatencies } from "./lib/pickup-gate-stats";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
const ENV_FILE_PATH = ".env.local";
/** 1リクエストの待ち時間の上限。応答が返らないまま評価全体が止まり続けるのを防ぐ */
const REQUEST_TIMEOUT_MS = 30_000;
/** 比較する採否の閾値(確率がこの値未満の候補を除去する) */
const THRESHOLDS = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7];
/** 誤判定した表現キーの一覧を出すときに使う閾値 */
const ERROR_LISTING_THRESHOLD = 0.5;

const responseSchema = z.object({
  answers: z.record(z.string(), z.object({ type: z.literal("noul"), noul: z.number() })),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** 1候補分の質問。表面形を質問文に埋め込み、yes / no の境目を criteria で明示する */
function buildQuestion(term: string) {
  return {
    type: "noul",
    instructions: `In \`message\`, is the phrase "${term}" used as a fixed expression (an idiom, phrasal verb, slang, greeting, or set phrase) with its conventional meaning as an expression?`,
    criteria: {
      true: "The words form one expression, and the message uses that expression's conventional meaning.",
      false:
        "The words merely appear next to each other: they belong to different phrases, are used literally word by word, or are part of a name.",
    },
  };
}

/** 1候補分の判定結果(本文は持たない) */
interface GateResult extends GateJudgment {
  id: number;
  latencyMs: number;
}

const [pairsPath, resultsPath] = process.argv.slice(2);
if (pairsPath === undefined || resultsPath === undefined) {
  throw new Error("使い方: npm run eval:gate -- eval-data/<ラベル付きの組>.jsonl eval-data/<判定結果の出力先>.jsonl");
}
if (existsSync(ENV_FILE_PATH)) {
  process.loadEnvFile(ENV_FILE_PATH);
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (apiKey === undefined || apiKey === "") {
  throw new Error(`TYPESAFE_API_KEY が設定されていません(${ENV_FILE_PATH} に記述してください)`);
}

const pairs: LabeledGatePair[] = readFileSync(pairsPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line, index) => {
    const parsed = labeledGatePairSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`${pairsPath}:${index + 1} がラベル付きの組のスキーマに合いません: ${parsed.error.message}`);
    }
    return parsed.data;
  });

// 同じ発言(同じ収集元の同じ本文)の候補を1リクエストにまとめる
const pairsByMessage = new Map<string, LabeledGatePair[]>();
for (const pair of pairs) {
  const messageKey = `${pair.source}\n${pair.text}`;
  pairsByMessage.set(messageKey, [...(pairsByMessage.get(messageKey) ?? []), pair]);
}

const results: GateResult[] = [];
const requestLatenciesMs: number[] = [];
let inputTokens = 0;
for (const messagePairs of pairsByMessage.values()) {
  const questions = Object.fromEntries(messagePairs.map((pair) => [`c${pair.id}`, buildQuestion(pair.term)]));
  const startedAt = performance.now();
  const response = await fetch(TYPESAFE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: { message: messagePairs[0].text }, model: TYPESAFE_MODEL, questions }),
    // 時間切れは例外になり、下の API 失敗と同じく評価全体を即座に失敗させる
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    // 途中までの結果で率を出すと誤解を招くため、リトライせず即座に失敗させる
    throw new Error(`TypeSafe API が失敗しました: status ${response.status} ${await response.text()}`);
  }
  const body = responseSchema.parse(await response.json());
  const latencyMs = performance.now() - startedAt;
  requestLatenciesMs.push(latencyMs);
  inputTokens += body.usage.input_tokens;
  for (const pair of messagePairs) {
    const answer = body.answers[`c${pair.id}`];
    if (answer === undefined) {
      throw new Error(`TypeSafe API の応答に候補 c${pair.id} の回答がありません`);
    }
    results.push({
      id: pair.id,
      expressionKey: pair.expressionKey,
      label: pair.label,
      idiomaticProbability: answer.noul,
      latencyMs,
    });
  }
}

writeFileSync(resultsPath, `${results.map((result) => JSON.stringify(result)).join("\n")}\n`);

/** 指定した条件に当てはまる候補の表現キーを、重複を除いて昇順で返す */
function expressionKeysWhere(predicate: (result: GateResult) => boolean): string[] {
  return [...new Set(results.filter(predicate).map((result) => result.expressionKey))].sort();
}

process.stdout.write(
  `${JSON.stringify(
    {
      model: TYPESAFE_MODEL,
      candidateCount: results.length,
      requestCount: requestLatenciesMs.length,
      inputTokens,
      latencyPerMessage: summarizeLatencies(requestLatenciesMs),
      byThreshold: THRESHOLDS.map((threshold) => summarizeGateJudgments(results, threshold)),
      errorsAtListingThreshold: {
        threshold: ERROR_LISTING_THRESHOLD,
        removedValuable: expressionKeysWhere(
          (result) => result.label === "valuable" && result.idiomaticProbability < ERROR_LISTING_THRESHOLD,
        ),
        keptLiteral: expressionKeysWhere(
          (result) => result.label === "literal" && result.idiomaticProbability >= ERROR_LISTING_THRESHOLD,
        ),
      },
    },
    null,
    2,
  )}\n`,
);
