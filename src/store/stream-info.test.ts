/**
 * src/store/stream-info.ts(接続中チャンネルの配信情報の保持)のテスト。
 *
 * `chat-connection.ts` の connect() で配信情報(タイトル・カテゴリ)を読み込み、
 * 翻訳・Pick up のシステムプロンプト組み立て(`translations.ts` / `pickups.ts`)が
 * 同期的に参照できる形で保持する流れと、チャンネル切り替え時のクリア・
 * 読み込み途中の結果破棄(世代ガード)を検証する。
 * 実際の API 呼び出しは行わず、フェイクの読み込み関数を注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamInfo, StreamInfoFetchResult } from "@/lib/twitch/stream-info";
import {
  clearStreamInfo,
  getStreamInfo,
  loadStreamInfo,
  refreshStreamInfo,
  resetStreamInfoForTests,
  startStreamInfoRefresh,
  stopStreamInfoRefresh,
  useStreamInfoStore,
} from "./stream-info";

afterEach(() => {
  resetStreamInfoForTests();
  vi.useRealTimers();
});

const FAKE_STREAM_INFO: StreamInfo = {
  title: "Mythic raid progression! !drops",
  category: "World of Warcraft",
  broadcasterId: "552120296",
  broadcasterLogin: "zackrawrr",
  broadcasterName: "ZackRawrr",
  gameId: "18122",
  viewerCount: 4321,
};

describe("loadStreamInfo", () => {
  it("未読み込みの間は null を返す(文脈なしの現行プロンプトで動作する)", () => {
    expect(getStreamInfo()).toBeNull();
  });

  it("読み込んだ配信情報を getStreamInfo と Zustand ストアの両方で参照できる", async () => {
    const fetchInfo = vi.fn(async () => FAKE_STREAM_INFO);

    await loadStreamInfo("zackrawrr", fetchInfo);

    expect(fetchInfo).toHaveBeenCalledWith("zackrawrr");
    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
    expect(useStreamInfoStore.getState().streamInfo).toEqual(FAKE_STREAM_INFO);
  });

  it("取得できない場合(オフライン・API 失敗 = null)は null のまま(文脈なしで動作する)", async () => {
    await loadStreamInfo("zackrawrr", async () => null);

    expect(getStreamInfo()).toBeNull();
  });

  it("読み込み完了前に clearStreamInfo された場合は結果を破棄する(チャンネル切り替え)", async () => {
    let resolveFetch: (info: StreamInfo | null) => void = () => {};
    const fetchInfo = vi.fn(() => new Promise<StreamInfo | null>((resolve) => (resolveFetch = resolve)));

    const loading = loadStreamInfo("zackrawrr", fetchInfo);
    clearStreamInfo();
    resolveFetch(FAKE_STREAM_INFO);
    await loading;

    expect(getStreamInfo()).toBeNull();
  });

  it("読み込み完了前に別チャンネルの読み込みが始まった場合、先に始めた読み込みの結果は破棄する", async () => {
    let resolveFirst: (info: StreamInfo | null) => void = () => {};
    const firstLoading = loadStreamInfo(
      "oldchannel",
      () => new Promise<StreamInfo | null>((resolve) => (resolveFirst = resolve)),
    );
    const secondLoading = loadStreamInfo("newchannel", async () => FAKE_STREAM_INFO);

    await secondLoading;
    resolveFirst({
      title: "古いチャンネルの配信",
      category: "Old Game",
      broadcasterId: "999",
      broadcasterLogin: "oldchannel",
      broadcasterName: "OldChannel",
      gameId: "111",
      viewerCount: 10,
    });
    await firstLoading;

    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
  });
});

/** リフレッシュで受け取る更新後の配信情報(視聴者数・カテゴリが変化したケース) */
const 更新後の配信情報: StreamInfo = {
  ...FAKE_STREAM_INFO,
  category: "Just Chatting",
  gameId: "509658",
  viewerCount: 9876,
};

describe("refreshStreamInfo", () => {
  it("live の場合は配信情報を更新する(視聴者数・カテゴリの変化を反映する)", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);

    await refreshStreamInfo(async () => ({ status: "live", info: 更新後の配信情報 }));

    expect(getStreamInfo()).toEqual(更新後の配信情報);
  });

  it("offline の場合は配信情報をクリアする(配信終了後にライブ風の視聴者数を残さない)", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);

    await refreshStreamInfo(async () => ({ status: "offline" }));

    expect(getStreamInfo()).toBeNull();
  });

  it("unavailable(API 失敗)の場合は既存の配信情報を保持する(リフレッシュの失敗でUIを壊さない)", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);

    await refreshStreamInfo(async () => ({ status: "unavailable" }));

    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
  });

  it("リフレッシュ完了前に clearStreamInfo された場合は結果を破棄する(チャンネル切り替え・切断)", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);
    let resolveFetch: (result: StreamInfoFetchResult) => void = () => {};
    const refreshing = refreshStreamInfo(
      () => new Promise<StreamInfoFetchResult>((resolve) => (resolveFetch = resolve)),
    );

    clearStreamInfo();
    resolveFetch({ status: "live", info: 更新後の配信情報 });
    await refreshing;

    expect(getStreamInfo()).toBeNull();
  });

  it("リフレッシュ完了前に別チャンネルの読み込みが始まった場合、遅れて届いた結果は破棄する", async () => {
    await loadStreamInfo("oldchannel", async () => FAKE_STREAM_INFO);
    let resolveFetch: (result: StreamInfoFetchResult) => void = () => {};
    const refreshing = refreshStreamInfo(
      () => new Promise<StreamInfoFetchResult>((resolve) => (resolveFetch = resolve)),
    );

    clearStreamInfo();
    await loadStreamInfo("newchannel", async () => 更新後の配信情報);
    resolveFetch({ status: "offline" });
    await refreshing;

    expect(getStreamInfo()).toEqual(更新後の配信情報);
  });
});

describe("startStreamInfoRefresh / stopStreamInfoRefresh", () => {
  it("60秒間隔でリフレッシュを繰り返し実行する", async () => {
    vi.useFakeTimers();
    const fetchResult = vi.fn(async (): Promise<StreamInfoFetchResult> => ({ status: "live", info: 更新後の配信情報 }));

    startStreamInfoRefresh("zackrawrr", fetchResult);
    expect(fetchResult).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResult).toHaveBeenCalledTimes(1);
    expect(fetchResult).toHaveBeenCalledWith("zackrawrr");
    expect(getStreamInfo()).toEqual(更新後の配信情報);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResult).toHaveBeenCalledTimes(2);
  });

  it("stopStreamInfoRefresh 後はリフレッシュしない(切断時)", async () => {
    vi.useFakeTimers();
    const fetchResult = vi.fn(async (): Promise<StreamInfoFetchResult> => ({ status: "live", info: 更新後の配信情報 }));

    startStreamInfoRefresh("zackrawrr", fetchResult);
    stopStreamInfoRefresh();

    await vi.advanceTimersByTimeAsync(180_000);
    expect(fetchResult).not.toHaveBeenCalled();
  });

  it("start を再度呼ぶと前のタイマーを止めて新しいチャンネルで開始する(チャンネル切り替え)", async () => {
    vi.useFakeTimers();
    const oldFetch = vi.fn(async (): Promise<StreamInfoFetchResult> => ({ status: "unavailable" }));
    const newFetch = vi.fn(async (): Promise<StreamInfoFetchResult> => ({ status: "unavailable" }));

    startStreamInfoRefresh("oldchannel", oldFetch);
    startStreamInfoRefresh("newchannel", newFetch);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(oldFetch).not.toHaveBeenCalled();
    expect(newFetch).toHaveBeenCalledTimes(1);
    expect(newFetch).toHaveBeenCalledWith("newchannel");
  });
});

describe("clearStreamInfo", () => {
  it("読み込み済みの配信情報を破棄して null に戻す", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);

    clearStreamInfo();

    expect(getStreamInfo()).toBeNull();
    expect(useStreamInfoStore.getState().streamInfo).toBeNull();
  });
});
