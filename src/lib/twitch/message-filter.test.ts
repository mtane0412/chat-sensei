/**
 * src/lib/twitch/message-filter.ts のテスト。
 *
 * 自動抽出パイプラインの最初の関門である `evaluateAutoExtractionCandidate` を検証する。
 * bot発言・!コマンド・emoteのみ・URLのみ・極端に短い発言・直近の重複が、
 * それぞれ正しい理由(reason)で除去されること、いずれにも該当しない発言は
 * 通過(null)することを確認する。
 */
import { describe, expect, it } from "vitest";
import type { TwitchChatMessage } from "./irc-parser";
import { evaluateAutoExtractionCandidate } from "./message-filter";

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

describe("evaluateAutoExtractionCandidate", () => {
  it("通常の発言は理由なし(null)で通過する", () => {
    const message = buildMessage();

    expect(evaluateAutoExtractionCandidate(message)).toBeNull();
  });

  it("既知のbotユーザー名(大文字小文字を区別しない)の発言は'bot'として除去される", () => {
    const message = buildMessage({ username: "Nightbot", text: "Now playing: Lo-Fi Beats" });

    expect(evaluateAutoExtractionCandidate(message)).toBe("bot");
  });

  it("!から始まる発言は'command'として除去される", () => {
    const message = buildMessage({ text: "!discord" });

    expect(evaluateAutoExtractionCandidate(message)).toBe("command");
  });

  it("前後の空白を除いた本文がemoteだけで構成される発言は'emote-only'として除去される", () => {
    const message = buildMessage({ text: " Kappa ", emotes: [{ id: "25", start: 1, end: 5 }] });

    expect(evaluateAutoExtractionCandidate(message)).toBe("emote-only");
  });

  it("テキストとemoteが混在する発言は通過する", () => {
    // "hello Kappa" のうち "Kappa"(6-10)だけがemote、残り"hello"は本文として十分な長さがある
    const message = buildMessage({ text: "hello Kappa", emotes: [{ id: "25", start: 6, end: 10 }] });

    expect(evaluateAutoExtractionCandidate(message)).toBeNull();
  });

  it("URLだけの発言は'url-only'として除去される", () => {
    const message = buildMessage({ text: "https://example.com/stream-highlights" });

    expect(evaluateAutoExtractionCandidate(message)).toBe("url-only");
  });

  it("URLとテキストが混在する発言は通過する", () => {
    const message = buildMessage({ text: "check this out https://example.com/clip" });

    expect(evaluateAutoExtractionCandidate(message)).toBeNull();
  });

  it("既定(strictness省略時 = normal)では4文字未満の発言は'too-short'として除去される", () => {
    const message = buildMessage({ text: "gg " });

    expect(evaluateAutoExtractionCandidate(message)).toBe("too-short");
  });

  it("strictnessをlooseにすると、より短い発言でも通過する", () => {
    const message = buildMessage({ text: "gg" });

    expect(evaluateAutoExtractionCandidate(message, { strictness: "loose" })).toBeNull();
  });

  it("strictnessをstrictにすると、normalでは通過する発言も'too-short'として除去される", () => {
    const message = buildMessage({ text: "nice one" }); // 8文字

    expect(evaluateAutoExtractionCandidate(message, { strictness: "normal" })).toBeNull();
    expect(evaluateAutoExtractionCandidate(message, { strictness: "strict" })).toBe("too-short");
  });

  it("直近の発言一覧に同一本文(前後空白・大文字小文字を無視)が含まれる場合は'duplicate'として除去される", () => {
    const message = buildMessage({ text: " Hello World " });

    expect(
      evaluateAutoExtractionCandidate(message, { recentTexts: ["hello world", "gg everyone"] }),
    ).toBe("duplicate");
  });

  it("直近の発言一覧に含まれていなければ重複とみなさない", () => {
    const message = buildMessage({ text: "totally different message here" });

    expect(
      evaluateAutoExtractionCandidate(message, { recentTexts: ["hello world", "gg everyone"] }),
    ).toBeNull();
  });

  it("複数の除去理由に該当する場合はbotが最優先で判定される", () => {
    const message = buildMessage({ username: "Moobot", text: "!" });

    expect(evaluateAutoExtractionCandidate(message)).toBe("bot");
  });
});
