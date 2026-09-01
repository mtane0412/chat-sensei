/**
 * src/lib/twitch/chat-command.ts のテスト。
 *
 * bot 向けのチャットコマンド(`!chimkin` など)を判定する純関数を検証する。
 * コマンドは翻訳・Pick up の対象外として原文のまま扱うため、判定の境界(先頭の空白、引数付き、
 * 文中の `!`、全角の `！`)を明確にする(issue #35)。
 */
import { describe, expect, it } from "vitest";
import { isChatCommandMessage } from "./chat-command";

describe("isChatCommandMessage", () => {
  it("`!` で始まる発言はコマンドとして true", () => {
    expect(isChatCommandMessage("!chimkin")).toBe(true);
  });

  it("引数付きのコマンド(`!chimkin please`)も発言全体をコマンド扱いにして true", () => {
    expect(isChatCommandMessage("!chimkin please")).toBe(true);
  });

  it("先頭の空白は無視して判定する", () => {
    expect(isChatCommandMessage("  !uptime")).toBe(true);
  });

  it("文中や末尾に `!` がある通常の発言は false", () => {
    expect(isChatCommandMessage("gg!")).toBe(false);
    expect(isChatCommandMessage("nice !chimkin")).toBe(false);
  });

  it("`!` だけ、または空文字列・空白のみの発言は false", () => {
    expect(isChatCommandMessage("!")).toBe(false);
    expect(isChatCommandMessage("!!!")).toBe(false);
    expect(isChatCommandMessage("")).toBe(false);
    expect(isChatCommandMessage("   ")).toBe(false);
  });

  it("全角の `！` で始まる発言はコマンドではないため false", () => {
    expect(isChatCommandMessage("！すごい")).toBe(false);
  });
});
