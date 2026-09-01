/**
 * src/lib/bot-filter.ts のテスト。
 *
 * チャット欄から除外する bot のユーザー名パターン(完全一致・`*` ワイルドカード)の
 * 解析・照合と、LocalStorage への保存・復元を検証する。壊れたデータの場合は
 * デフォルトに戻し、その旨を呼び出し元が判定できることを確認する(Fail-Fast 方針)。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BOT_FILTER_STORAGE_KEY,
  DEFAULT_BOT_FILTER_PATTERNS,
  formatBotFilterPatterns,
  loadBotFilterPatterns,
  matchesBotFilter,
  parseBotFilterPatterns,
  saveBotFilterPatterns,
} from "./bot-filter";

afterEach(() => {
  window.localStorage.clear();
});

describe("parseBotFilterPatterns", () => {
  it("改行区切りの入力を、前後の空白を除いたパターンの配列にする", () => {
    expect(parseBotFilterPatterns("nightbot\n  streamelements  \n*trans")).toEqual([
      "nightbot",
      "streamelements",
      "*trans",
    ]);
  });

  it("カンマ区切り・空行・重複を許容し、空要素と重複は取り除く", () => {
    expect(parseBotFilterPatterns("nightbot, moobot,\n\nnightbot\n")).toEqual(["nightbot", "moobot"]);
  });

  it("Twitch のログイン名は小文字のため、パターンも小文字に正規化する", () => {
    expect(parseBotFilterPatterns("NightBot\n*Trans")).toEqual(["nightbot", "*trans"]);
  });
});

describe("formatBotFilterPatterns", () => {
  it("パターン配列を1行1件のテキストに戻す(入力欄の初期値用)", () => {
    expect(formatBotFilterPatterns(["nightbot", "*trans"])).toBe("nightbot\n*trans");
  });
});

describe("matchesBotFilter", () => {
  it("ワイルドカード無しのパターンはユーザー名と完全一致した場合だけ除外する", () => {
    expect(matchesBotFilter("nightbot", ["nightbot"])).toBe(true);
    expect(matchesBotFilter("nightbot2", ["nightbot"])).toBe(false);
    expect(matchesBotFilter("mynightbot", ["nightbot"])).toBe(false);
  });

  it("先頭の `*` は任意の文字列に一致する(配信者ごとに個別の翻訳botを一括除外できる)", () => {
    expect(matchesBotFilter("yuki_trans", ["*trans"])).toBe(true);
    expect(matchesBotFilter("streamer_bot", ["*bot"])).toBe(true);
    expect(matchesBotFilter("trans_fan", ["*trans"])).toBe(false);
  });

  it("`*` は末尾・途中にも置ける", () => {
    expect(matchesBotFilter("botrix", ["bot*"])).toBe(true);
    expect(matchesBotFilter("my_trans_bot", ["*trans*"])).toBe(true);
    expect(matchesBotFilter("streamelements", ["stream*ments"])).toBe(true);
    expect(matchesBotFilter("streamlabs", ["stream*ments"])).toBe(false);
  });

  it("正規表現のメタ文字を含むユーザー名・パターンでも文字として扱う", () => {
    expect(matchesBotFilter("a.b", ["a.b"])).toBe(true);
    expect(matchesBotFilter("axb", ["a.b"])).toBe(false);
  });

  it("ユーザー名の大文字小文字は区別しない", () => {
    expect(matchesBotFilter("NightBot", ["nightbot"])).toBe(true);
  });

  it("どのパターンにも一致しなければ除外しない", () => {
    expect(matchesBotFilter("viewer_taro", ["nightbot", "*trans"])).toBe(false);
    expect(matchesBotFilter("viewer_taro", [])).toBe(false);
  });
});

describe("DEFAULT_BOT_FILTER_PATTERNS", () => {
  it("著名な Twitch bot(Nightbot / StreamElements / Moobot / Fossabot)を初期状態で除外する", () => {
    for (const bot of ["nightbot", "streamelements", "moobot", "fossabot"]) {
      expect(matchesBotFilter(bot, DEFAULT_BOT_FILTER_PATTERNS)).toBe(true);
    }
  });

  it("一般の視聴者名は初期状態では除外しない", () => {
    expect(matchesBotFilter("viewer_taro", DEFAULT_BOT_FILTER_PATTERNS)).toBe(false);
  });
});

describe("loadBotFilterPatterns / saveBotFilterPatterns", () => {
  it("保存されたデータが無い場合はデフォルトのパターンを返す", () => {
    expect(loadBotFilterPatterns()).toEqual({ patterns: DEFAULT_BOT_FILTER_PATTERNS, wasCorrupted: false });
  });

  it("保存したパターンをそのまま復元する(空配列 = すべて除外しない、も保存できる)", () => {
    saveBotFilterPatterns(["nightbot", "*trans"]);
    expect(loadBotFilterPatterns()).toEqual({ patterns: ["nightbot", "*trans"], wasCorrupted: false });

    saveBotFilterPatterns([]);
    expect(loadBotFilterPatterns()).toEqual({ patterns: [], wasCorrupted: false });
  });

  it("JSONとして壊れたデータの場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, "{ これはJSONではない");

    expect(loadBotFilterPatterns()).toEqual({ patterns: DEFAULT_BOT_FILTER_PATTERNS, wasCorrupted: true });
  });

  it("文字列配列以外が保存されている場合はデフォルトに戻し、壊れていたことを伝える", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify({ patterns: "nightbot" }));

    expect(loadBotFilterPatterns()).toEqual({ patterns: DEFAULT_BOT_FILTER_PATTERNS, wasCorrupted: true });
  });
});
