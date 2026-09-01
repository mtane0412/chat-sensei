/**
 * 自動パイプライン(`auto-pipeline.ts` / `translations.ts` / `pickups.ts`)のテストで共有する
 * フィクスチャとフェイク。Prompt API・環境診断・発言の購読はすべてフェイクを注入し、実ブラウザ API には触れない。
 *
 * テスト専用のモジュールのため、プロダクションコードから import しないこと。
 */
import { vi } from "vitest";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import type { SessionPool } from "@/lib/ai/session-pool";
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
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** Prompt API が利用可能/不可能な環境診断結果 */
export function createDiagnosis(overallReady: boolean): EnvironmentDiagnosis {
  return {
    chromeVersion: 150,
    meetsMinimumChromeVersion: true,
    languageModel: overallReady
      ? { supported: true, availability: "available" }
      : { supported: false, availability: null },
    languageDetector: { supported: false, availability: null },
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
 * - `pool.enqueue` は run にフェイクセッションを渡し、prompt の結果は `promptResults` から順に取り出す
 */
export function createDeps(options: { ready?: boolean; promptResults?: Array<Promise<string>> } = {}) {
  const listeners = new Set<(message: TwitchChatMessage) => void>();
  let messages: TwitchChatMessage[] = [];
  const promptResults = [...(options.promptResults ?? [])];

  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) => {
    const next = promptResults.shift();
    if (!next) throw new Error("テストの promptResults が不足しています");
    return run({ prompt: () => next });
  });
  const warmUp = vi.fn(async () => {});
  const pool = { enqueue, warmUp } as unknown as SessionPool;

  const deps: AutoPipelineDeps = {
    diagnose: vi.fn(async () => createDiagnosis(options.ready ?? true)),
    loadSettings: () => ({ targetLang: "en", explainLang: "ja" }),
    createPool: vi.fn(() => pool),
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

  return { deps, emit, setMessages, enqueue, warmUp, listeners };
}

/** 非同期の状態更新(診断 → 投入 → 完了)が落ち着くまでマイクロタスクをフラッシュする */
export async function flush(times = 10) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
