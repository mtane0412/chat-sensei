/**
 * チャット発言1件からGemini Nano(Prompt API)に注目の表現(語句と意味のペア)を
 * 抜き出させるオーケストレーション層。
 *
 * `translate.ts` と同じ構造で、Pick up 専用のプロンプト・スキーマを使う。
 *
 * - `pickUpExpressions`: `pickup-filter.ts` で emote・@メンション・URL を除いた本文を
 *   `SessionPool` のジョブに積み、返ってきたJSON文字列を `pickupSchema` で検証し、
 *   emote 名などの決定的に除外できる語句を落としたうえで、各語句が LLM に渡した本文に
 *   登場することを照合してから返す(モデルが解説言語の語や言い換えを「原文の語句」として
 *   返した応答は失敗として扱う)。自由文をパースする脆い処理は行わない。
 *   emote だけの発言のように渡す本文が空になる場合は LLM を呼ばず、空の結果を返す(issue #26)。
 * - `createPickupBaseSessionFactory`: Pick up 専用のシステムプロンプトを持つ
 *   ベースセッションの生成関数を組み立てる。`session-pool.ts` はベースセッションを
 *   1つしか持たないため、翻訳用・解説用とはプールを分ける前提(issue #15 の方針 (a))。
 */
import type { EmotePosition } from "@/lib/twitch/irc-parser";
import { filterPickupTerms, preparePickupInput } from "./pickup-filter";
import { buildPickupSystemPrompt, buildPickupUserPrompt, type SupportedLanguage } from "./prompts";
import { buildPickupResponseConstraint, pickupSchema, type PickupResult } from "./schemas";
import type { JobPriority, PromptSessionLike, SessionPool } from "./session-pool";

export interface PickupOptions {
  /** 抽出は受信した全発言を自動で処理するバックグラウンド生成のため、既定は low */
  priority?: JobPriority;
  signal?: AbortSignal;
  /** Twitch IRC の `emotes` タグから得た emote の位置。省略時は emote の除去を行わない */
  emotes?: EmotePosition[];
  /** 結果から落とす名前(表示中の発言者名など)。@ 無しで本文に書かれたユーザー名は LLM が語句として返しやすい */
  excludedNames?: string[];
}

/**
 * チャット本文から注目の表現を抽出する。
 * Prompt API の応答は必ず JSON 文字列として返るため、`JSON.parse` → `pickupSchema.parse` →
 * 決定的な後段フィルタ → 本文との照合の順で処理し、パース・照合に失敗した場合はエラーを投げる。
 * 照合は大文字小文字を区別しない(「W」を「w」として返す程度の揺れは原文の語句とみなす)。
 */
export async function pickUpExpressions(
  sessionPool: SessionPool,
  chatMessageText: string,
  options: PickupOptions = {},
): Promise<PickupResult> {
  const priority = options.priority ?? "low";
  const prepared = preparePickupInput(chatMessageText, options.emotes ?? []);
  if (prepared.text === "") {
    return { terms: [] };
  }

  const raw = await sessionPool.enqueue(
    priority,
    (session) =>
      session.prompt(buildPickupUserPrompt(prepared.text), {
        responseConstraint: buildPickupResponseConstraint(),
      }),
    options.signal,
  );

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Prompt APIの応答をJSONとして解釈できませんでした: ${raw}`, { cause: error });
  }

  const terms = filterPickupTerms(pickupSchema.parse(parsed).terms, prepared, options.excludedNames ?? []);
  const normalizedText = prepared.text.toLowerCase();
  const unknownTerm = terms.find((term) => !normalizedText.includes(term.term.toLowerCase()));
  if (unknownTerm) {
    throw new Error(`Prompt APIが原文に登場しない語句を返しました: ${unknownTerm.term}`);
  }
  return { terms };
}

/**
 * 学ぶ言語・意味を書く言語のペアから、Pick up 専用の `SessionPool` に渡すベースセッション生成関数を組み立てる。
 * `window.LanguageModel` は診断済み(availability.ts)である前提で呼び出す。
 */
export function createPickupBaseSessionFactory(
  targetLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): () => Promise<PromptSessionLike> {
  return async () =>
    LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildPickupSystemPrompt(targetLang, explainLang) }],
      expectedInputs: [{ type: "text", languages: [targetLang, explainLang] }],
      expectedOutputs: [{ type: "text", languages: [explainLang] }],
    });
}
