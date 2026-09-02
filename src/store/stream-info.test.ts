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
import type { StreamInfo } from "@/lib/twitch/stream-info";
import {
  clearStreamInfo,
  getStreamInfo,
  loadStreamInfo,
  resetStreamInfoForTests,
  useStreamInfoStore,
} from "./stream-info";

afterEach(() => {
  resetStreamInfoForTests();
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

describe("clearStreamInfo", () => {
  it("読み込み済みの配信情報を破棄して null に戻す", async () => {
    await loadStreamInfo("zackrawrr", async () => FAKE_STREAM_INFO);

    clearStreamInfo();

    expect(getStreamInfo()).toBeNull();
    expect(useStreamInfoStore.getState().streamInfo).toBeNull();
  });
});
