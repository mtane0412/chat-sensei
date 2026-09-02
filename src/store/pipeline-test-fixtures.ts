/**
 * 自動パイプライン(`auto-pipeline.ts` / `translations.ts` / `pickups.ts`)のテストで共有する
 * フィクスチャとフェイク。Prompt API・環境診断・発言の購読はすべてフェイクを注入し、実ブラウザ API には触れない。
 *
 * テスト専用のモジュールのため、プロダクションコードから import しないこと。
 */
import { vi } from "vitest";
import type { ApiDiagnosis, EnvironmentDiagnosis } from "@/lib/ai/availability";
import type { DetectedLanguageCandidate, LanguageDetectorLike } from "@/lib/ai/detect-language";
import type { SessionPool } from "@/lib/ai/session-pool";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/settings";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import type { AutoPipelineDeps } from "./auto-pipeline";

/** テスト用のサンプル発言(実況チャットにありそうな「ナイスプレー」の一言) */
export function createMessage(overrides: Partial<TwitchChatMessage> = {}): TwitchChatMessage {
  return {
    id: "msg-1",
    channel: "example",
    userId: "1234",
    username: "viewer_taro",
    displayName: "viewer_taro",
    color: null,
    text: "gg chat",
    isAction: false,
    emotes: [],
    badges: [],
    bits: null,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** Prompt API と Language Detector がどちらも利用可能/どちらも不可能な環境診断結果 */
export function createDiagnosis(overallReady: boolean): EnvironmentDiagnosis {
  const api: ApiDiagnosis = overallReady
    ? { supported: true, availability: "available" }
    : { supported: false, availability: null };
  return {
    chromeVersion: 150,
    meetsMinimumChromeVersion: true,
    languageModel: api,
    languageDetector: api,
    storageEstimate: { quota: null, usage: null },
    overallReady,
  };
}

/** Deferred パターン: テストから任意のタイミングで resolve/reject できる Promise */
export function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * テスト用の依存性一式を組み立てる。
 * - `emit(message)` で発言受信を模擬する(表示用リングバッファにも追加する)
 * - `setMessages(next)` で表示用リングバッファの中身を差し替える(発言が溢れた状況の模擬)
 * - `pool.enqueue` は run にフェイクセッション(`prompt` スパイ)を渡し、prompt の結果は `promptResults` から順に取り出す
 * - 逆方向(解説言語→学ぶ言語)のジョブ用に、順方向とは別の `reversePool`(`reverseEnqueue` / `reversePrompt` /
 *   `reverseWarmUp`。結果は `reversePromptResults` から取り出す)を `createReversePool` が返す
 * - `detect` はフェイクの Language Detector。既定では全発言を `detectedLanguage`(既定 "en")と判定する
 * - `settings` は既定で「英語を学ぶ / 日本語で解説」
 */
export function createDeps(
  options: {
    ready?: boolean;
    promptResults?: Array<Promise<string>>;
    reversePromptResults?: Array<Promise<string>>;
    detectedLanguage?: string;
    settings?: Settings;
  } = {},
) {
  const listeners = new Set<(message: TwitchChatMessage) => void>();
  let messages: TwitchChatMessage[] = [];
  const promptResults = [...(options.promptResults ?? [])];
  const reversePromptResults = [...(options.reversePromptResults ?? [])];
  const settings: Settings = options.settings ?? { ...DEFAULT_SETTINGS, learningLang: "en", explainLang: "ja" };

  /** フェイクセッションの prompt。LLM に渡された本文(ユーザープロンプト)を検証するために公開する */
  const prompt = vi.fn((): Promise<string> => {
    const next = promptResults.shift();
    if (!next) throw new Error("テストの promptResults が不足しています");
    return next;
  });
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt });
  });
  const warmUp = vi.fn(async () => {});
  const dispose = vi.fn();
  const pool = { enqueue, warmUp, dispose } as unknown as SessionPool;

  /** 逆方向ジョブ用のフェイクセッションの prompt。順方向と分けて検証できるようにする */
  const reversePrompt = vi.fn((): Promise<string> => {
    const next = reversePromptResults.shift();
    if (!next) throw new Error("テストの reversePromptResults が不足しています");
    return next;
  });
  const reverseEnqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    return run({ prompt: reversePrompt });
  });
  const reverseWarmUp = vi.fn(async () => {});
  const reverseDispose = vi.fn();
  const reversePool = { enqueue: reverseEnqueue, warmUp: reverseWarmUp, dispose: reverseDispose } as unknown as SessionPool;

  /** フェイクの Language Detector。判定に渡された本文を検証するために公開する */
  const detect = vi.fn(
    async (): Promise<DetectedLanguageCandidate[]> => [
      { detectedLanguage: options.detectedLanguage ?? "en", confidence: 0.9 },
    ],
  );
  /** フェイクの Language Detector の destroy。停止時にネイティブセッションを破棄することを検証するために公開する */
  const detectorDestroy = vi.fn();
  const createDetector = vi.fn(async (): Promise<LanguageDetectorLike> => ({ detect, destroy: detectorDestroy }));

  const deps: AutoPipelineDeps = {
    diagnose: vi.fn(async () => createDiagnosis(options.ready ?? true)),
    loadSettings: () => settings,
    createPool: vi.fn(() => pool),
    createReversePool: vi.fn(() => reversePool),
    createDetector,
    subscribeToChatMessages: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getMessages: () => messages,
  };

  function emit(message: TwitchChatMessage) {
    messages = [...messages, message];
    listeners.forEach((listener) => listener(message));
  }

  function setMessages(next: TwitchChatMessage[]) {
    messages = next;
  }

  return {
    deps,
    emit,
    setMessages,
    enqueue,
    prompt,
    warmUp,
    dispose,
    reverseEnqueue,
    reversePrompt,
    reverseWarmUp,
    reverseDispose,
    detect,
    detectorDestroy,
    createDetector,
    listeners,
  };
}

/** 非同期の状態更新(診断 → 投入 → 完了)が落ち着くまでマイクロタスクをフラッシュする */
export async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
