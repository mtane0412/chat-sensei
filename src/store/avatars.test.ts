/**
 * src/store/avatars.ts(発言者アバター URL のキャッシュ)のテスト。
 *
 * 発言受信時に `requestAvatar` へ渡された発言者 ID を短い待ち時間でバッチにまとめ、
 * Helix の Get Users API(`/users?id=`)経由でプロフィール画像 URL を取得して
 * Zustand ストアに保持する流れを検証する。
 * 実際の API 呼び出しは行わず、フェイクの取得関数を注入する。
 * バッチの待ち時間はフェイクタイマーで進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AVATAR_BATCH_WINDOW_MS,
  clearAvatarLoadFailures,
  requestAvatar,
  resetAvatarsForTests,
  useAvatarStore,
} from "./avatars";

/** バッチの待ち時間を経過させ、取得の Promise を解決させる */
async function advanceBatchWindow() {
  vi.advanceTimersByTime(AVATAR_BATCH_WINDOW_MS);
  // fetchAvatars の Promise 解決(マイクロタスク)を消化する
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  resetAvatarsForTests();
  vi.useRealTimers();
});

describe("requestAvatar", () => {
  it("バッチ待ち時間内に要求された複数の発言者 ID を 1 回の取得にまとめ、ストアに保持する", async () => {
    const fetchAvatars = vi.fn(async () =>
      new Map([
        ["1234", "https://cdn.example/taro.png"],
        ["5678", "https://cdn.example/hanako.png"],
      ]),
    );

    requestAvatar("1234", fetchAvatars);
    requestAvatar("5678", fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).toHaveBeenCalledTimes(1);
    expect(fetchAvatars).toHaveBeenCalledWith(["1234", "5678"]);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
      "5678": "https://cdn.example/hanako.png",
    });
  });

  it("取得済み・取得中の ID は再取得しない(同じ発言者の連続発言でリクエストを増やさない)", async () => {
    const fetchAvatars = vi.fn(async () => new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234", fetchAvatars);
    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();
    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).toHaveBeenCalledTimes(1);
  });

  it("userId が null(タグ無し)の発言は無視する", async () => {
    const fetchAvatars = vi.fn(async () => new Map<string, string>());

    requestAvatar(null, fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).not.toHaveBeenCalled();
  });

  it("レスポンスに含まれない ID(退会済みなど)はアバターなしのまま、再取得もしない", async () => {
    const fetchAvatars = vi.fn(async () => new Map<string, string>());

    requestAvatar("9999", fetchAvatars);
    await advanceBatchWindow();
    requestAvatar("9999", fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({});
  });

  it("取得失敗(null = Helix 利用不可)の ID はアバターなしのまま、再取得しない(失敗の記録をクリアするまで)", async () => {
    const fetchAvatars = vi.fn(async () => null);

    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();
    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();

    // Helix 利用不可時に発言のたびにリクエストを繰り返さない
    expect(fetchAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({});
  });

  it("clearAvatarLoadFailures(チャンネル切り替え)後は、失敗した ID を再取得できる", async () => {
    const fetchAvatars = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();
    clearAvatarLoadFailures();
    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).toHaveBeenCalledTimes(2);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
    });
  });

  it("取得成功した ID は clearAvatarLoadFailures 後も再取得しない(アバターはチャンネル固有ではないため持ち越す)", async () => {
    const fetchAvatars = vi.fn(async () => new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();
    clearAvatarLoadFailures();
    requestAvatar("1234", fetchAvatars);
    await advanceBatchWindow();

    expect(fetchAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
    });
  });

  it("キャッシュが上限を超えたら古い発言者から削除する(メモリの際限ない増加を防ぐ)", async () => {
    // 上限 + 1 件を取得させ、最初の 1 件が捨てられることを確認する
    const { MAX_AVATAR_CACHE_ENTRIES } = await import("./avatars");
    const fetchAvatars = vi.fn(async (ids: readonly string[]) =>
      new Map(ids.map((id) => [id, `https://cdn.example/${id}.png`])),
    );

    requestAvatar("oldest", fetchAvatars);
    await advanceBatchWindow();
    for (let i = 0; i < MAX_AVATAR_CACHE_ENTRIES; i += 1) {
      requestAvatar(`user-${i}`, fetchAvatars);
    }
    await advanceBatchWindow();

    const avatars = useAvatarStore.getState().avatars;
    expect(Object.keys(avatars)).toHaveLength(MAX_AVATAR_CACHE_ENTRIES);
    expect(avatars["oldest"]).toBeUndefined();
    expect(avatars["user-0"]).toBe("https://cdn.example/user-0.png");
  });
});
