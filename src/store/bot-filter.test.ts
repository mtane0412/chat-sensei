/**
 * src/store/bot-filter.ts(bot除外パターンのストア)のテスト。
 *
 * 除外パターンは LocalStorage に永続化しつつ、モジュールスコープの Zustand ストアで
 * 保持する。SSR 中に LocalStorage へ触れないよう、復元(hydrate)は明示的に呼ぶ設計とし、
 * 復元は1度だけ行われること・保存データが壊れていた場合はデフォルトに戻したうえで
 * その事実を公開することを検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOT_FILTER_STORAGE_KEY,
  DEFAULT_BOT_FILTER_PATTERNS,
  loadBotFilterConfig,
} from "@/lib/bot-filter";
import {
  hydrateBotFilterStore,
  isExcludedByBotFilter,
  resetBotFilterStoreForTests,
  useBotFilterStore,
} from "./bot-filter";

beforeEach(() => {
  resetBotFilterStoreForTests();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("hydrateBotFilterStore", () => {
  it("LocalStorage に保存済みのパターンをストアに復元する", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify(["*trans"]));

    hydrateBotFilterStore();

    expect(useBotFilterStore.getState().patterns).toEqual(["*trans"]);
    expect(useBotFilterStore.getState().excludeBroadcaster).toBe(false);
    expect(useBotFilterStore.getState().hydrated).toBe(true);
    expect(useBotFilterStore.getState().wasCorrupted).toBe(false);
  });

  it("新形式(配信者除外オン)の保存データも復元する", () => {
    window.localStorage.setItem(
      BOT_FILTER_STORAGE_KEY,
      JSON.stringify({ patterns: ["*trans"], excludeBroadcaster: true }),
    );

    hydrateBotFilterStore();

    expect(useBotFilterStore.getState().patterns).toEqual(["*trans"]);
    expect(useBotFilterStore.getState().excludeBroadcaster).toBe(true);
  });

  it("保存データが無ければデフォルトのパターンになる", () => {
    hydrateBotFilterStore();

    expect(useBotFilterStore.getState().patterns).toEqual(DEFAULT_BOT_FILTER_PATTERNS);
  });

  it("保存データが壊れていればデフォルトに戻し、wasCorrupted を true にする", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, "壊れたデータ");

    hydrateBotFilterStore();

    expect(useBotFilterStore.getState().patterns).toEqual(DEFAULT_BOT_FILTER_PATTERNS);
    expect(useBotFilterStore.getState().wasCorrupted).toBe(true);
  });

  it("2回目以降の呼び出しでは、ストア上の変更を LocalStorage の値で上書きしない", () => {
    hydrateBotFilterStore();
    useBotFilterStore.getState().setPatterns(["custom_bot"]);
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify(["other_bot"]));

    hydrateBotFilterStore();

    expect(useBotFilterStore.getState().patterns).toEqual(["custom_bot"]);
  });
});

describe("setBotFilter", () => {
  it("パターンと配信者除外の両方を更新し、LocalStorage にも保存する", () => {
    hydrateBotFilterStore();

    useBotFilterStore.getState().setBotFilter({ patterns: ["nightbot"], excludeBroadcaster: true });

    expect(useBotFilterStore.getState().patterns).toEqual(["nightbot"]);
    expect(useBotFilterStore.getState().excludeBroadcaster).toBe(true);
    expect(loadBotFilterConfig().config).toEqual({ patterns: ["nightbot"], excludeBroadcaster: true });
  });
});

describe("setPatterns", () => {
  it("配信者除外の設定は変えずに、パターンだけを更新する", () => {
    hydrateBotFilterStore();
    useBotFilterStore.getState().setBotFilter({ patterns: [], excludeBroadcaster: true });

    useBotFilterStore.getState().setPatterns(["nightbot"]);

    expect(useBotFilterStore.getState().patterns).toEqual(["nightbot"]);
    expect(useBotFilterStore.getState().excludeBroadcaster).toBe(true);
  });

  it("ストアを更新し、LocalStorage にも保存する", () => {
    hydrateBotFilterStore();

    useBotFilterStore.getState().setPatterns(["nightbot", "*trans"]);

    expect(useBotFilterStore.getState().patterns).toEqual(["nightbot", "*trans"]);
    expect(loadBotFilterConfig().config.patterns).toEqual(["nightbot", "*trans"]);
  });

  it("保存に成功したら wasCorrupted を false に戻す(壊れていたデータは正常な値で上書きされたため)", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, "壊れたデータ");
    hydrateBotFilterStore();

    useBotFilterStore.getState().setPatterns(["nightbot"]);

    expect(useBotFilterStore.getState().wasCorrupted).toBe(false);
  });
});

describe("isExcludedByBotFilter", () => {
  it("未復元なら先に LocalStorage から復元してから判定する", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify(["*trans"]));

    expect(isExcludedByBotFilter("yuki_trans", null)).toBe(true);
    expect(isExcludedByBotFilter("viewer_taro", null)).toBe(false);
    expect(useBotFilterStore.getState().hydrated).toBe(true);
  });

  it("配信者除外がオンなら、チャンネル名と同じユーザー名を除外する", () => {
    window.localStorage.setItem(BOT_FILTER_STORAGE_KEY, JSON.stringify({ patterns: [], excludeBroadcaster: true }));

    expect(isExcludedByBotFilter("zackrawrr", "zackrawrr")).toBe(true);
    expect(isExcludedByBotFilter("viewer_taro", "zackrawrr")).toBe(false);
  });
});
