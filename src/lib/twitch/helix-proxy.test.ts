/**
 * src/lib/twitch/helix-proxy.ts(Helix プロキシ呼び出しの共通ヘルパー)のテスト。
 *
 * Helix プロキシ(`/api/twitch/`)への fetch ラッパー(HTTP エラー・ネットワークエラーを
 * null に丸めて console.warn する制御フロー)と、`{data: [...]}` エンベロープの
 * 前段パースを検証する。実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** 指定した JSON を返す成功レスポンスのフェイク fetch を作る */
function createFetchStub(json: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => json,
  }) as unknown as typeof fetch;
}

/** 指定したステータスの失敗レスポンスのフェイク fetch を作る */
function createErrorFetchStub(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: async () => ({}),
  }) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchHelixJson", () => {
  it("プロキシのパスに /api/twitch/ を前置し、成功レスポンスの JSON を返す", async () => {
    const fetchStub = createFetchStub({ data: [{ title: "作業配信" }] });

    const json = await fetchHelixJson("streams", { fetchFn: fetchStub });

    expect(fetchStub).toHaveBeenCalledWith("/api/twitch/streams", { signal: undefined });
    expect(json).toEqual({ data: [{ title: "作業配信" }] });
  });

  it("params を渡すとクエリ文字列として付加する(繰り返しキーも保持する)", async () => {
    const fetchStub = createFetchStub({ data: [] });
    const params = new URLSearchParams();
    params.append("id", "111");
    params.append("id", "222");

    await fetchHelixJson("users", { params, fetchFn: fetchStub });

    expect(fetchStub).toHaveBeenCalledWith("/api/twitch/users?id=111&id=222", { signal: undefined });
  });

  it("params の値は URL エンコードされる", async () => {
    const fetchStub = createFetchStub({ data: [] });
    const params = new URLSearchParams({ query: "日本語 チャンネル" });

    await fetchHelixJson("search/channels", { params, fetchFn: fetchStub });

    expect(fetchStub).toHaveBeenCalledWith(
      `/api/twitch/search/channels?query=${encodeURIComponent("日本語 チャンネル").replaceAll("%20", "+")}`,
      { signal: undefined },
    );
  });

  it("HTTP エラーの場合は null を返し、failureLog の文言で console.warn する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = createErrorFetchStub(503);

    const json = await fetchHelixJson("streams", {
      fetchFn: fetchStub,
      failureLog: { subject: "配信情報", fallback: "文脈なしで動作します" },
    });

    expect(json).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("配信情報の取得に失敗しました(HTTP 503)。文脈なしで動作します");
  });

  it("ネットワークエラーの場合は null を返し、failureLog の文言とエラーで console.warn する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const networkError = new Error("ネットワーク断");
    const fetchStub = vi.fn().mockRejectedValue(networkError) as unknown as typeof fetch;

    const json = await fetchHelixJson("streams", {
      fetchFn: fetchStub,
      failureLog: { subject: "配信情報", fallback: "文脈なしで動作します" },
    });

    expect(json).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith("配信情報の取得に失敗しました。文脈なしで動作します", networkError);
  });

  it("failureLog を渡さない場合は console.warn せずに null を返す(オートコンプリートなど静かに失敗したい用途)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await fetchHelixJson("search/channels", { fetchFn: createErrorFetchStub(429) })).toBeNull();
    expect(
      await fetchHelixJson("search/channels", {
        fetchFn: vi.fn().mockRejectedValue(new Error("中断")) as unknown as typeof fetch,
      }),
    ).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("レスポンス本文の JSON 解析に失敗した場合も null を返す(制御フローは catch に合流する)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchStub = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("JSON ではない本文");
      },
    }) as unknown as typeof fetch;

    const json = await fetchHelixJson("streams", {
      fetchFn: fetchStub,
      failureLog: { subject: "配信情報", fallback: "文脈なしで動作します" },
    });

    expect(json).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("signal を fetch にそのまま渡す(オートコンプリートの中断用)", async () => {
    const fetchStub = createFetchStub({ data: [] });
    const controller = new AbortController();

    await fetchHelixJson("search/channels", { fetchFn: fetchStub, signal: controller.signal });

    expect(fetchStub).toHaveBeenCalledWith("/api/twitch/search/channels", { signal: controller.signal });
  });
});

describe("extractDataArray", () => {
  it("{data: [...]} エンベロープから data 配列を取り出す", () => {
    expect(extractDataArray({ data: [{ id: "111" }, { id: "222" }] })).toEqual([
      { id: "111" },
      { id: "222" },
    ]);
  });

  it("オブジェクトでない値(null・文字列)は null を返す", () => {
    expect(extractDataArray(null)).toBeNull();
    expect(extractDataArray("文字列のレスポンス")).toBeNull();
  });

  it("data が配列でない場合は null を返す", () => {
    expect(extractDataArray({ data: "配列ではない" })).toBeNull();
    expect(extractDataArray({})).toBeNull();
  });

  it("data が空配列の場合は空配列をそのまま返す(空判定は呼び出し側の責務)", () => {
    expect(extractDataArray({ data: [] })).toEqual([]);
  });
});
