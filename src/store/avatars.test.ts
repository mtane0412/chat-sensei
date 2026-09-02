/**
 * src/store/avatars.ts(発言者アバター URL のキャッシュ)のテスト。
 *
 * 発言受信時に `requestAvatar` へ渡された発言者 ID を短い待ち時間でバッチにまとめ、
 * Helix の Get Users API(`/users?id=`)経由でプロフィール画像 URL を取得して
 * Zustand ストアに保持する流れを検証する。
 * 実際の API 呼び出しは行わないよう、取得関数(`fetchUserAvatars`)はモジュールごとモックする。
 * バッチの待ち時間はフェイクタイマーで進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFetchUserAvatars = vi.fn<(ids: readonly string[]) => Promise<Map<string, string> | null>>();

vi.mock("@/lib/twitch/user-avatars", () => ({
  fetchUserAvatars: (ids: readonly string[]) => mockFetchUserAvatars(ids),
}));

import {
  AVATAR_BATCH_WINDOW_MS,
  MAX_AVATAR_CACHE_ENTRIES,
  clearAvatarLoadFailures,
  requestAvatar,
  resetAvatarsForTests,
  useAvatarStore,
} from "./avatars";

/** バッチの待ち時間を経過させ、取得の Promise を解決させる */
async function advanceBatchWindow() {
  vi.advanceTimersByTime(AVATAR_BATCH_WINDOW_MS);
  // fetchUserAvatars の Promise 解決(マイクロタスク)を消化する
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetchUserAvatars.mockReset();
});

afterEach(() => {
  resetAvatarsForTests();
  vi.useRealTimers();
});

describe("requestAvatar", () => {
  it("バッチ待ち時間内に要求された複数の発言者 ID を 1 回の取得にまとめ、ストアに保持する", async () => {
    mockFetchUserAvatars.mockResolvedValue(
      new Map([
        ["1234", "https://cdn.example/taro.png"],
        ["5678", "https://cdn.example/hanako.png"],
      ]),
    );

    requestAvatar("1234");
    requestAvatar("5678");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
    expect(mockFetchUserAvatars).toHaveBeenCalledWith(["1234", "5678"]);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
      "5678": "https://cdn.example/hanako.png",
    });
  });

  it("取得済み・取得中の ID は再取得しない(同じ発言者の連続発言でリクエストを増やさない)", async () => {
    mockFetchUserAvatars.mockResolvedValue(new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234");
    requestAvatar("1234");
    await advanceBatchWindow();
    requestAvatar("1234");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
  });

  it("取得中(リクエスト送信済み・未応答)の ID は、次のバッチにも積まない", async () => {
    // 1 回目の取得を未解決のままにして「取得中」の状態を作る
    let resolveFirst: (result: Map<string, string> | null) => void = () => {};
    mockFetchUserAvatars.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
    );

    requestAvatar("1234");
    await advanceBatchWindow();
    // 取得中に同じ発言者がもう一度発言する
    requestAvatar("1234");
    await advanceBatchWindow();
    resolveFirst(new Map([["1234", "https://cdn.example/taro.png"]]));
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
  });

  it("userId が null(タグ無し)・空文字(値なしタグ)の発言は無視する", async () => {
    // IRC パーサーは値なしタグ(`user-id=`)を空文字にするため、空文字も Helix へ送らない
    requestAvatar(null);
    requestAvatar("");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).not.toHaveBeenCalled();
  });

  it("レスポンスに含まれない ID(退会済みなど)はアバターなしとして確定し、再取得しない", async () => {
    mockFetchUserAvatars.mockResolvedValue(new Map());

    requestAvatar("9999");
    await advanceBatchWindow();
    requestAvatar("9999");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({});
  });

  it("取得失敗(null = Helix 利用不可)後は、新しい ID も含めて取得を止める(発言のたびにリクエストを繰り返さない)", async () => {
    mockFetchUserAvatars.mockResolvedValue(null);

    requestAvatar("1234");
    await advanceBatchWindow();
    // 失敗後は同じ ID も初見の ID もリクエストしない
    requestAvatar("1234");
    requestAvatar("5678");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({});
  });

  it("clearAvatarLoadFailures(チャンネル切り替え)後は、失敗した ID を再取得できる", async () => {
    mockFetchUserAvatars
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234");
    await advanceBatchWindow();
    clearAvatarLoadFailures();
    requestAvatar("1234");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(2);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
    });
  });

  it("取得成功した ID は clearAvatarLoadFailures 後も再取得しない(アバターはチャンネル固有ではないため持ち越す)", async () => {
    mockFetchUserAvatars.mockResolvedValue(new Map([["1234", "https://cdn.example/taro.png"]]));

    requestAvatar("1234");
    await advanceBatchWindow();
    clearAvatarLoadFailures();
    requestAvatar("1234");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(1);
    expect(useAvatarStore.getState().avatars).toEqual({
      "1234": "https://cdn.example/taro.png",
    });
  });

  it("clearAvatarLoadFailures 後に完了した(クリア前に開始していた)バッチの失敗は、利用不可として記録しない", async () => {
    // チャンネル切り替えの瞬間に進行中だった前チャンネルのバッチが失敗しても、
    // 新チャンネルでの取得を止めてはならない(世代フェンス)
    let resolveFirst: (result: Map<string, string> | null) => void = () => {};
    mockFetchUserAvatars
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(new Map([["5678", "https://cdn.example/hanako.png"]]));

    requestAvatar("1234");
    await advanceBatchWindow();
    clearAvatarLoadFailures();
    resolveFirst(null);
    await vi.advanceTimersByTimeAsync(0);
    requestAvatar("5678");
    await advanceBatchWindow();

    expect(mockFetchUserAvatars).toHaveBeenCalledTimes(2);
    expect(useAvatarStore.getState().avatars).toEqual({
      "5678": "https://cdn.example/hanako.png",
    });
  });

  it("キャッシュが上限を超えたら、参照が最も古い発言者から削除する(メモリの際限ない増加を防ぐ)", async () => {
    mockFetchUserAvatars.mockImplementation(async (ids) =>
      new Map(ids.map((id) => [id, `https://cdn.example/${id}.png`])),
    );

    requestAvatar("oldest");
    await advanceBatchWindow();
    for (let i = 0; i < MAX_AVATAR_CACHE_ENTRIES; i += 1) {
      requestAvatar(`user-${i}`);
    }
    await advanceBatchWindow();

    const avatars = useAvatarStore.getState().avatars;
    expect(Object.keys(avatars)).toHaveLength(MAX_AVATAR_CACHE_ENTRIES);
    expect(avatars["oldest"]).toBeUndefined();
    expect(avatars["user-0"]).toBe("https://cdn.example/user-0.png");
  });

  it("取得済み ID への再要求は参照位置を最新に更新し、上限超過時に捨てられにくくする(LRU)", async () => {
    mockFetchUserAvatars.mockImplementation(async (ids) =>
      new Map(ids.map((id) => [id, `https://cdn.example/${id}.png`])),
    );

    requestAvatar("regular");
    await advanceBatchWindow();
    requestAvatar("one-shot");
    await advanceBatchWindow();
    // 常連(regular)がもう一度発言 → 参照位置が one-shot より新しくなる
    requestAvatar("regular");
    // 上限まで埋めて 1 件だけ捨てさせる
    for (let i = 0; i < MAX_AVATAR_CACHE_ENTRIES - 1; i += 1) {
      requestAvatar(`user-${i}`);
    }
    await advanceBatchWindow();

    const avatars = useAvatarStore.getState().avatars;
    expect(avatars["one-shot"]).toBeUndefined();
    expect(avatars["regular"]).toBe("https://cdn.example/regular.png");
  });
});
