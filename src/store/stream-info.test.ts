/**
 * src/store/stream-info.ts(接続中チャンネルの配信情報の保持)のテスト。
 *
 * `chat-connection.ts` の connect() で配信情報(タイトル・カテゴリ)を読み込み、
 * 翻訳・Pick up のシステムプロンプト組み立て(`translations.ts` / `pickups.ts`)が
 * 同期的に参照できる形で保持する流れと、チャンネル切り替え時のクリア・
 * 読み込み途中の結果破棄(世代ガード)、接続中の定期リフレッシュ(issue #85)を検証する。
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

/** リフレッシュで受け取る更新後の配信情報(視聴者数・カテゴリが変化したケース) */
const 更新後の配信情報: StreamInfo = {
  ...FAKE_STREAM_INFO,
  category: "Just Chatting",
  gameId: "509658",
  viewerCount: 9876,
};

/** ライブ配信中の取得結果を返すフェイク読み込み関数を作る */
function live(info: StreamInfo): () => Promise<StreamInfoFetchResult> {
  return async () => ({ status: "live", info });
}

describe("loadStreamInfo", () => {
  it("未読み込みの間は null を返す(文脈なしの現行プロンプトで動作する)", () => {
    expect(getStreamInfo()).toBeNull();
  });

  it("読み込んだ配信情報を getStreamInfo と Zustand ストアの両方で参照できる", async () => {
    const fetchResult = vi.fn(live(FAKE_STREAM_INFO));

    await loadStreamInfo("zackrawrr", fetchResult);

    expect(fetchResult).toHaveBeenCalledWith("zackrawrr");
    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
    expect(useStreamInfoStore.getState().streamInfo).toEqual(FAKE_STREAM_INFO);
  });

  it("オフライン(配信していない)の場合は null のまま(文脈なしで動作する)", async () => {
    await loadStreamInfo("zackrawrr", async () => ({ status: "offline" }));

    expect(getStreamInfo()).toBeNull();
  });

  it("取得に失敗した場合(Helix 未設定・API 失敗)は null のまま(文脈なしで動作する)", async () => {
    await loadStreamInfo("zackrawrr", async () => ({ status: "unavailable" }));

    expect(getStreamInfo()).toBeNull();
  });

  it("読み込み完了前に clearStreamInfo された場合は結果を破棄する(チャンネル切り替え)", async () => {
    let resolveFetch: (result: StreamInfoFetchResult) => void = () => {};
    const fetchResult = vi.fn(() => new Promise<StreamInfoFetchResult>((resolve) => (resolveFetch = resolve)));

    const loading = loadStreamInfo("zackrawrr", fetchResult);
    clearStreamInfo();
    resolveFetch({ status: "live", info: FAKE_STREAM_INFO });
    await loading;

    expect(getStreamInfo()).toBeNull();
  });

  it("読み込み完了前に別チャンネルの読み込みが始まった場合、先に始めた読み込みの結果は破棄する", async () => {
    let resolveFirst: (result: StreamInfoFetchResult) => void = () => {};
    const firstLoading = loadStreamInfo(
      "oldchannel",
      () => new Promise<StreamInfoFetchResult>((resolve) => (resolveFirst = resolve)),
    );
    const secondLoading = loadStreamInfo("newchannel", live(FAKE_STREAM_INFO));

    await secondLoading;
    resolveFirst({
      status: "live",
      info: {
        title: "古いチャンネルの配信",
        category: "Old Game",
        broadcasterId: "999",
        broadcasterLogin: "oldchannel",
        broadcasterName: "OldChannel",
        gameId: "111",
        viewerCount: 10,
      },
    });
    await firstLoading;

    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
  });
});

describe("refreshStreamInfo", () => {
  it("live の場合は配信情報を更新する(視聴者数・カテゴリの変化を反映する)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    await refreshStreamInfo(live(更新後の配信情報));

    expect(getStreamInfo()).toEqual(更新後の配信情報);
  });

  it("live で内容が前回と同一の場合はストアを更新しない(60秒ごとの無駄な再レンダリングを避ける)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));
    const 更新前の参照 = useStreamInfoStore.getState().streamInfo;

    // parseStreamInfo は毎回新しいオブジェクトを返すため、内容が同じでも参照は異なる
    await refreshStreamInfo(live({ ...FAKE_STREAM_INFO }));

    expect(useStreamInfoStore.getState().streamInfo).toBe(更新前の参照);
  });

  it("offline が1回だけの場合は既存の配信情報を保持する(Helix の一時的な空レスポンスでパイプラインを再起動しない)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    await refreshStreamInfo(async () => ({ status: "offline" }));

    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
  });

  it("offline が2回連続した場合は配信情報をクリアする(配信終了後にライブ風の視聴者数を残さない)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    await refreshStreamInfo(async () => ({ status: "offline" }));
    await refreshStreamInfo(async () => ({ status: "offline" }));

    expect(getStreamInfo()).toBeNull();
  });

  it("offline の後に live に戻った場合は連続カウントをリセットする(その後の offline 1回ではクリアしない)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    await refreshStreamInfo(async () => ({ status: "offline" }));
    await refreshStreamInfo(live(更新後の配信情報));
    await refreshStreamInfo(async () => ({ status: "offline" }));

    expect(getStreamInfo()).toEqual(更新後の配信情報);
  });

  it("unavailable(API 失敗)の場合は既存の配信情報を保持する(リフレッシュの失敗でUIを壊さない)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    await refreshStreamInfo(async () => ({ status: "unavailable" }));

    expect(getStreamInfo()).toEqual(FAKE_STREAM_INFO);
  });

  it("リフレッシュ完了前に clearStreamInfo された場合は結果を破棄する(チャンネル切り替え・切断)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));
    let resolveFetch: (result: StreamInfoFetchResult) => void = () => {};
    const refreshing = refreshStreamInfo(
      () => new Promise<StreamInfoFetchResult>((resolve) => (resolveFetch = resolve)),
    );

    clearStreamInfo();
    resolveFetch({ status: "live", info: 更新後の配信情報 });
    await refreshing;

    expect(getStreamInfo()).toBeNull();
  });

  it("リフレッシュ同士が追い越した場合、先に始めた古いリフレッシュの結果は破棄する(遅延 fetch との競合)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));
    let resolveSlow: (result: StreamInfoFetchResult) => void = () => {};
    const slowRefreshing = refreshStreamInfo(
      () => new Promise<StreamInfoFetchResult>((resolve) => (resolveSlow = resolve)),
    );

    // 後から始めたリフレッシュが先に完了して最新の情報を反映する
    await refreshStreamInfo(live(更新後の配信情報));
    // 遅れて届いた古いスナップショットは最新の情報を上書きしない
    resolveSlow({ status: "live", info: FAKE_STREAM_INFO });
    await slowRefreshing;

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
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));

    clearStreamInfo();

    expect(getStreamInfo()).toBeNull();
    expect(useStreamInfoStore.getState().streamInfo).toBeNull();
  });

  it("offline の連続カウントもリセットする(前チャンネルの offline を新チャンネルに持ち越さない)", async () => {
    await loadStreamInfo("zackrawrr", live(FAKE_STREAM_INFO));
    await refreshStreamInfo(async () => ({ status: "offline" }));

    clearStreamInfo();
    await loadStreamInfo("newchannel", live(更新後の配信情報));
    await refreshStreamInfo(async () => ({ status: "offline" }));

    // 新チャンネルでは offline 1回目のため、まだクリアしない
    expect(getStreamInfo()).toEqual(更新後の配信情報);
  });
});
