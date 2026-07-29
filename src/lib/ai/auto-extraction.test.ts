/**
 * src/lib/ai/auto-extraction.ts のテスト。
 *
 * message-filter(除去) → triage(学習価値判定) → explain(解説生成) → candidates保存、
 * という自動抽出パイプライン全体の振る舞いを検証する。
 * `LanguageModel` は実際には呼び出さず、`SessionPool` をフェイクに差し替える。
 * フェイクの `prompt` は `responseConstraint.type` を見て、triage呼び出し(boolean)か
 * explain呼び出し(object)かを判別し、対応する結果を返す。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAutoExtractionPipeline, type ProcessMessageOptions } from "./auto-extraction";
import { createSessionPool, type SessionPool } from "./session-pool";
import { db } from "../db/schema";
import type { TwitchChatMessage } from "../twitch/irc-parser";

/** テスト対象のチャット発言を組み立てるヘルパー(意味の分かる実在しそうなチャット文を使用) */
function buildMessage(overrides: Partial<TwitchChatMessage> = {}): TwitchChatMessage {
  return {
    id: "msg-1",
    channel: "zackrawrr",
    userId: "111",
    username: "yamada_taro",
    displayName: "山田太郎",
    color: "#1E90FF",
    text: "that was such a clutch play honestly",
    isAction: false,
    emotes: [],
    badges: [],
    timestampMs: 1690000000000,
    ...overrides,
  };
}

/** テスト用の最小限のSessionPoolフェイク。responseConstraintの型でtriage/explainの呼び出しを判別する */
function createFakeSessionPool(options: { triageResult: boolean; explanationJson?: string }) {
  const fakeSession = {
    prompt: vi.fn(async (_input: string, promptOptions?: { responseConstraint?: { type?: string } }) => {
      if (promptOptions?.responseConstraint?.type === "boolean") {
        return JSON.stringify(options.triageResult);
      }
      return (
        options.explanationJson ?? JSON.stringify({ translation: "t", literal: "l", items: [], difficulty: 1 })
      );
    }),
  };
  const enqueue = vi.fn(async (_priority: "high" | "low", run: (session: unknown) => Promise<string>) =>
    run(fakeSession),
  );
  return { enqueue } as unknown as SessionPool & { enqueue: typeof enqueue };
}

const baseOptions: ProcessMessageOptions = {
  strictness: "normal",
  targetLang: "en",
  explainLang: "ja",
};

afterEach(async () => {
  await db.candidates.clear();
});

describe("createAutoExtractionPipeline", () => {
  it("botの発言はフィルタで除去され、triage/explainは呼ばれず候補も保存されない", async () => {
    const pool = createFakeSessionPool({ triageResult: true });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool });

    await pipeline.processMessage(buildMessage({ username: "Nightbot" }), baseOptions);

    expect(pool.enqueue).not.toHaveBeenCalled();
    expect(await db.candidates.count()).toBe(0);
  });

  it("フィルタを通過してもtriageがfalseの場合はexplainを呼ばず、候補も保存されない", async () => {
    const pool = createFakeSessionPool({ triageResult: false });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool });

    await pipeline.processMessage(buildMessage(), baseOptions);

    expect(pool.enqueue).toHaveBeenCalledTimes(1); // triageのみ
    expect(await db.candidates.count()).toBe(0);
  });

  it("フィルタを通過しtriageがtrueの場合はexplainの結果を各語句候補として保存する", async () => {
    const explanationJson = JSON.stringify({
      translation: "土壇場での見事なプレーだった、正直",
      literal: "それはとても土壇場のプレーだった、正直",
      items: [
        { term: "clutch", kind: "word", meaning: "土壇場での見事なプレー", note: "対戦ゲームでよく使われる" },
        { term: "honestly", kind: "word", meaning: "正直なところ", note: "文末で強調に使われる" },
      ],
      difficulty: 2,
    });
    const pool = createFakeSessionPool({ triageResult: true, explanationJson });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool });
    const message = buildMessage({
      text: "that was such a clutch play honestly",
      channel: "zackrawrr",
      displayName: "山田太郎",
    });

    await pipeline.processMessage(message, baseOptions);

    expect(pool.enqueue).toHaveBeenCalledTimes(2); // triage → explain
    const candidates = await db.candidates.toArray();
    expect(candidates).toHaveLength(2);
    expect(candidates.map((c) => c.term)).toEqual(["clutch", "honestly"]);
    expect(candidates[0]).toMatchObject({
      meaning: "土壇場での見事なプレー",
      note: "対戦ゲームでよく使われる",
      sourceMessageText: "that was such a clutch play honestly",
      sourceChannel: "zackrawrr",
      sourceAuthor: "山田太郎",
      targetLang: "en",
      explainLang: "ja",
      tags: [],
    });
  });

  it("直近の発言と同一本文の場合は重複として除去され、2回目はtriageすら呼ばれない", async () => {
    const pool = createFakeSessionPool({ triageResult: true });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool });
    const message = buildMessage({ text: "another totally unique chat message" });

    await pipeline.processMessage(message, baseOptions);
    await pipeline.processMessage(message, baseOptions);

    // 1回目はtriage→explainで2回、2回目は重複除去されるため呼ばれない
    expect(pool.enqueue).toHaveBeenCalledTimes(2);
  });

  it("直近の重複判定バッファは指定件数を超えると古い発言から対象外になる", async () => {
    const pool = createFakeSessionPool({ triageResult: true });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool, recentTextsBufferSize: 1 });

    await pipeline.processMessage(buildMessage({ id: "msg-a", text: "first unique message here" }), baseOptions);
    await pipeline.processMessage(buildMessage({ id: "msg-b", text: "second unique message here" }), baseOptions);
    // バッファ長1のため、この時点で記憶されているのは直前の"second..."のみで、
    // "first..."の重複は検出されない(=フィルタを通過し、triage→explainが呼ばれる)
    // (idは別発言であることを表すためmsg-aとは変えている)
    await pipeline.processMessage(buildMessage({ id: "msg-c", text: "first unique message here" }), baseOptions);

    expect(pool.enqueue).toHaveBeenCalledTimes(6); // 3発言 × (triage + explain)
  });

  it("同一message.idの発言が再度渡された場合は二重処理とみなされ、triageすら呼ばれず候補も増えない", async () => {
    // 画面再マウント等でリスナーが二重登録された場合など、同じ発言が2回processMessageに
    // 渡されてしまうケースを想定する(irc-client側は同一privmsgに同じidを振る)。
    const explanationJson = JSON.stringify({
      translation: "そのプレー土壇場だったね",
      literal: "それは土壇場のプレーだった",
      items: [{ term: "clutch", kind: "word", meaning: "土壇場での見事なプレー", note: "対戦ゲームでよく使われる" }],
      difficulty: 2,
    });
    const pool = createFakeSessionPool({ triageResult: true, explanationJson });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool });
    const message = buildMessage({ id: "msg-clutch-play", text: "that was such a clutch play honestly" });

    await pipeline.processMessage(message, baseOptions);
    await pipeline.processMessage(message, baseOptions);

    // 1回目はtriage→explainで2回、2回目は同一idのため除去され呼ばれない
    expect(pool.enqueue).toHaveBeenCalledTimes(2);
    expect(await db.candidates.count()).toBe(1);
  });

  it("message.idがnullの発言は重複チェックの対象外となり、同じ内容の発言が続いても毎回triage/explainが呼ばれる", async () => {
    // TwitchChatMessage.id は id タグを取得できなかった場合 null になりうる(irc-parser.ts参照)。
    // null同士を誤って同一発言とみなしてしまうと、idを取得できない発言が2件目以降
    // 一切処理されなくなってしまうため、その回帰を防ぐ。
    const pool = createFakeSessionPool({ triageResult: true });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool, recentTextsBufferSize: 1 });
    const messageA = buildMessage({ id: null, text: "first message without an id here" });
    const messageB = buildMessage({ id: null, text: "second totally different message here" });

    await pipeline.processMessage(messageA, baseOptions);
    await pipeline.processMessage(messageB, baseOptions); // 本文重複判定バッファ(サイズ1)からmessageAの本文を押し出す
    await pipeline.processMessage(messageA, baseOptions); // idがnullのため重複チェックにかからず通過する

    expect(pool.enqueue).toHaveBeenCalledTimes(6); // 3発言 × (triage + explain)
  });

  it("直近テキストの重複判定バッファが溢れて本文重複が検出できない場合でも、同一message.idの発言は二重処理から除去される", async () => {
    const pool = createFakeSessionPool({ triageResult: true });
    const pipeline = createAutoExtractionPipeline({ sessionPool: pool, recentTextsBufferSize: 1 });
    const message = buildMessage({ id: "msg-original", text: "first duplicate-prone message here" });
    const otherMessage = buildMessage({ id: "msg-other", text: "second totally different message here" });

    await pipeline.processMessage(message, baseOptions);
    await pipeline.processMessage(otherMessage, baseOptions); // 本文重複判定バッファ(サイズ1)からmessageの本文を押し出す
    await pipeline.processMessage(message, baseOptions); // 本文重複チェックは効かないはずだが、id重複チェックで除去される

    // message: triage+explain(2) / otherMessage: triage+explain(2) / messageの再送: 除去され0
    expect(pool.enqueue).toHaveBeenCalledTimes(4);
  });

  it("中断済みのsignalを渡した場合はエラーになり、候補は保存されない", async () => {
    const realPool = createSessionPool({
      createBaseSession: async () => ({ prompt: vi.fn(), clone: vi.fn(), destroy: vi.fn() }),
    });
    const pipeline = createAutoExtractionPipeline({ sessionPool: realPool });
    const controller = new AbortController();
    controller.abort();

    await expect(
      pipeline.processMessage(buildMessage(), { ...baseOptions, signal: controller.signal }),
    ).rejects.toThrow();

    expect(await db.candidates.count()).toBe(0);
  });
});
