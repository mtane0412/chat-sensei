/**
 * OpenRouter API のクライアント。Gemini Nano(Prompt API)の代わりに、利用者自身の
 * OpenRouter API キーで任意のクラウド LLM を使えるようにする(設定 `llmProvider: "openrouter"`)。
 *
 * - `fetchOpenRouterModels`: モデル一覧 API(GET /models)から選択肢を取得する(設定ダイアログで使用)
 * - `createOpenRouterSessionFactory`: 既存パイプラインがそのまま使えるよう、Prompt API の
 *   セッションと互換の `PromptSessionLike` を返す生成関数を組み立てる。`responseConstraint`
 *   (JSON Schema)は OpenRouter の Structured Outputs(`response_format: json_schema`)に対応させる
 *
 * chat-sensei はサーバーを持たないため、リクエストはブラウザから直接 OpenRouter へ送る。
 * HTTP エラーや想定外の応答は暗黙にフォールバックせず、理由付きの例外を投げる(Fail-Fast)。
 */
import { z } from "zod";
import type { PromptSessionLike } from "./session-pool";

export const OPENROUTER_API_BASE_URL = "https://openrouter.ai/api/v1";

/** モデル一覧 API の応答のうち、この画面で使う項目だけを検証する(他の項目は無視する) */
const modelsResponseSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string().min(1),
      name: z.string().optional(),
    }),
  ),
});

/** エラー応答の本文(`{"error": {"message": "..."}}`)。理由の取り出しに失敗しても例外は投げる */
const errorResponseSchema = z.looseObject({
  error: z.looseObject({ message: z.string() }).optional(),
});

/** chat/completions の応答のうち、この画面で使う項目だけを検証する */
const completionResponseSchema = z.object({
  choices: z
    .array(
      z.looseObject({
        message: z.looseObject({ content: z.string() }),
      }),
    )
    .min(1, "OpenRouter returned no choices"),
});

/** 設定ダイアログのモデル選択に表示する 1 モデルぶんの情報 */
export interface OpenRouterModel {
  id: string;
  /** 表示名。API が name を返さないモデルは id をそのまま使う */
  name: string;
}

/**
 * OpenRouter のモデル一覧を取得し、id 昇順で返す。
 * モデル一覧 API は API キー無しで呼び出せるため、認証ヘッダは付けない。
 * HTTP エラー・スキーマ不一致は例外を投げる(暗黙に空一覧へフォールバックしない)。
 */
export async function fetchOpenRouterModels(fetchFn: typeof fetch = fetch): Promise<OpenRouterModel[]> {
  const response = await fetchFn(`${OPENROUTER_API_BASE_URL}/models`);
  if (!response.ok) {
    throw new Error(`OpenRouter models API failed with status ${response.status}`);
  }
  const parsed = modelsResponseSchema.parse(await response.json());
  return parsed.data
    .map((model) => ({ id: model.id, name: model.name ?? model.id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** OpenRouter セッションの設定。API キー・モデルは利用者の設定(`lib/settings.ts`)から渡す */
export interface OpenRouterSessionConfig {
  apiKey: string;
  /** モデル ID(例: "anthropic/claude-sonnet-5") */
  model: string;
  /** 用途(翻訳・Pick up)ごとのシステムプロンプト */
  systemPrompt: string;
}

/** エラー応答の本文から理由を取り出す。取り出せない場合は null */
function extractErrorMessage(body: unknown): string | null {
  const parsed = errorResponseSchema.safeParse(body);
  return parsed.success ? (parsed.data.error?.message ?? null) : null;
}

/**
 * `SessionPool` にそのまま渡せる、OpenRouter 向けベースセッションの生成関数を組み立てる。
 *
 * Prompt API と違いセッションはサーバー側の状態を持たないため、`clone()` は同じ設定の
 * セッションを返すだけ、`destroy()` は何もしない。1 回の `prompt()` が
 * 「システムプロンプト + ユーザープロンプト」の独立した chat/completions リクエストになる
 * (既存パイプラインもクローンセッションに 1 回だけ prompt する使い方のため、意味は変わらない)。
 */
export function createOpenRouterSessionFactory(
  config: OpenRouterSessionConfig,
  fetchFn: typeof fetch = fetch,
): () => Promise<PromptSessionLike> {
  async function prompt(
    input: string,
    options?: { responseConstraint?: Record<string, unknown>; signal?: AbortSignal },
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: "system", content: config.systemPrompt },
        { role: "user", content: input },
      ],
    };
    if (options?.responseConstraint) {
      // Prompt API の responseConstraint(JSON Schema)を OpenRouter の Structured Outputs に対応させる
      body.response_format = {
        type: "json_schema",
        json_schema: { name: "response", strict: true, schema: options.responseConstraint },
      };
    }

    const response = await fetchFn(`${OPENROUTER_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: options?.signal,
    });

    if (!response.ok) {
      const reason = extractErrorMessage(await response.json().catch(() => null));
      throw new Error(
        `OpenRouter chat completion failed with status ${response.status}${reason ? `: ${reason}` : ""}`,
      );
    }

    const parsed = completionResponseSchema.parse(await response.json());
    return parsed.choices[0].message.content;
  }

  function createSession(): PromptSessionLike {
    return {
      prompt,
      clone: async () => createSession(),
      destroy: () => {},
    };
  }

  return async () => createSession();
}
