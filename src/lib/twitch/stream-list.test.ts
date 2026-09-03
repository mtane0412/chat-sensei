/**
 * src/lib/twitch/stream-list.ts(言語ペアタグ付き配信一覧)のテスト。
 *
 * Helix の Get Streams API(`GET /streams?language=&first=`)のレスポンスを
 * 配信一覧として解析する処理、タグの言語照合(自由入力の表記ゆれ・大文字小文字の吸収)、
 * 言語ペアの両タグを含む配信だけを残すフィルタ、および Next.js プロキシ
 * (`/api/twitch/streams`)経由の取得を検証する。
 * 実際の API 呼び出しは行わず、フェイクの fetch を注入する。
 */
import { describe, expect, it, vi } from "vitest";
import {
  fetchLanguagePairStreams,
  filterStreamsByLanguagePair,
  parseTaggedStreams,
  streamHasLanguageTag,
  type TaggedStream,
} from "./stream-list";

/** Helix Get Streams API のレスポンス(検証に使う部分のみ) */
function createHelixStreamsJson(): unknown {
  return {
    data: [
      {
        user_login: "eigo_sensei",
        user_name: "英語の先生",
        title: "English & Japanese chatting stream",
        game_name: "Just Chatting",
        viewer_count: 321,
        thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_eigo_sensei-{width}x{height}.jpg",
        tags: ["English", "日本語", "LearnJapanese"],
      },
      {
        user_login: "solo_gamer",
        user_name: "SoloGamer",
        title: "ranked grind",
        game_name: "VALORANT",
        viewer_count: 55,
        thumbnail_url: "https://static-cdn.jtvnw.net/previews-ttv/live_user_solo_gamer-{width}x{height}.jpg",
        tags: ["English"],
      },
    ],
  };
}

describe("parseTaggedStreams", () => {
  it("レスポンスから配信一覧(login・表示名・タイトル・カテゴリ・視聴者数・サムネイル・タグ)を順序どおり取り出す", () => {
    const streams = parseTaggedStreams(createHelixStreamsJson());
    expect(streams).toEqual([
      {
        login: "eigo_sensei",
        displayName: "英語の先生",
        title: "English & Japanese chatting stream",
        category: "Just Chatting",
        viewerCount: 321,
        thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_eigo_sensei-440x248.jpg",
        tags: ["English", "日本語", "LearnJapanese"],
      },
      {
        login: "solo_gamer",
        displayName: "SoloGamer",
        title: "ranked grind",
        category: "VALORANT",
        viewerCount: 55,
        thumbnailUrl: "https://static-cdn.jtvnw.net/previews-ttv/live_user_solo_gamer-440x248.jpg",
        tags: ["English"],
      },
    ] satisfies TaggedStream[]);
  });

  it("data が空の場合は空配列を返す", () => {
    expect(parseTaggedStreams({ data: [] })).toEqual([]);
  });

  it("data 配列が無い・オブジェクトでない場合は null を返す", () => {
    expect(parseTaggedStreams({})).toBeNull();
    expect(parseTaggedStreams("文字列のボディ")).toBeNull();
    expect(parseTaggedStreams(null)).toBeNull();
  });

  it("user_login が無い項目・型が想定と異なる項目は読み飛ばす", () => {
    const json = {
      data: [
        { user_name: "loginなし", tags: ["English"] },
        "文字列の項目",
        {
          user_login: "valid_user",
          user_name: "ValidUser",
          title: "配信中",
          game_name: "Minecraft",
          viewer_count: 10,
          thumbnail_url: "https://example.com/thumb-{width}x{height}.jpg",
          tags: ["English", "日本語"],
        },
      ],
    };
    expect(parseTaggedStreams(json)).toEqual([
      {
        login: "valid_user",
        displayName: "ValidUser",
        title: "配信中",
        category: "Minecraft",
        viewerCount: 10,
        thumbnailUrl: "https://example.com/thumb-440x248.jpg",
        tags: ["English", "日本語"],
      },
    ]);
  });

  it("任意フィールドが欠けた項目は、表示名は login・文字列は空文字・視聴者数は null・タグは空配列として読み込む", () => {
    const json = { data: [{ user_login: "bare_user" }] };
    expect(parseTaggedStreams(json)).toEqual([
      {
        login: "bare_user",
        displayName: "bare_user",
        title: "",
        category: "",
        viewerCount: null,
        thumbnailUrl: "",
        tags: [],
      },
    ]);
  });

  it("tags 配列に文字列以外が混じっている場合、その要素だけ読み飛ばす", () => {
    const json = { data: [{ user_login: "mixed_tags", tags: ["English", 123, null, "日本語"] }] };
    const streams = parseTaggedStreams(json);
    expect(streams?.[0].tags).toEqual(["English", "日本語"]);
  });

  it("tags 配列に同じタグが重複している場合、最初の1つだけを残す(実際の Helix レスポンスに重複がありうるため)", () => {
    // 実例: あるアート配信のタグに「イラスト」が2回含まれていた(そのまま表示すると React の key が重複する)
    const json = { data: [{ user_login: "art_streamer", tags: ["art", "イラスト", "English", "イラスト"] }] };
    const streams = parseTaggedStreams(json);
    expect(streams?.[0].tags).toEqual(["art", "イラスト", "English"]);
  });
});

describe("streamHasLanguageTag", () => {
  it("言語に対応するタグ候補語(英語名・ネイティブ表記)のいずれかと一致すれば true を返す", () => {
    expect(streamHasLanguageTag(["Japanese"], "ja")).toBe(true);
    expect(streamHasLanguageTag(["日本語"], "ja")).toBe(true);
    expect(streamHasLanguageTag(["English"], "en")).toBe(true);
    expect(streamHasLanguageTag(["Español"], "es")).toBe(true);
    expect(streamHasLanguageTag(["Spanish"], "es")).toBe(true);
    expect(streamHasLanguageTag(["Deutsch"], "de")).toBe(true);
    expect(streamHasLanguageTag(["German"], "de")).toBe(true);
    expect(streamHasLanguageTag(["Français"], "fr")).toBe(true);
    expect(streamHasLanguageTag(["French"], "fr")).toBe(true);
  });

  it("大文字小文字・アクセント無し表記の違いを吸収する", () => {
    expect(streamHasLanguageTag(["JAPANESE"], "ja")).toBe(true);
    expect(streamHasLanguageTag(["espanol"], "es")).toBe(true);
    expect(streamHasLanguageTag(["francais"], "fr")).toBe(true);
  });

  it("対応するタグが無ければ false を返す", () => {
    expect(streamHasLanguageTag(["English", "Gaming"], "ja")).toBe(false);
    expect(streamHasLanguageTag([], "en")).toBe(false);
  });

  it("タグ内の部分一致では true にしない(タグ全体との一致のみ)", () => {
    expect(streamHasLanguageTag(["LearnJapanese"], "ja")).toBe(false);
  });
});

describe("filterStreamsByLanguagePair", () => {
  /** タグだけが検証に関係するため、他フィールドは最小のダミー値で埋める */
  function createStream(login: string, tags: string[]): TaggedStream {
    return {
      login,
      displayName: login,
      title: "",
      category: "",
      viewerCount: null,
      thumbnailUrl: "",
      tags,
    };
  }

  it("学習言語と解説言語の両方のタグを含む配信だけを順序を保って残す", () => {
    const streams = [
      createStream("both_tags", ["English", "日本語"]),
      createStream("learning_only", ["English"]),
      createStream("explain_only", ["日本語"]),
      createStream("no_tags", []),
      createStream("both_tags_2", ["Japanese", "english", "Gaming"]),
    ];
    expect(filterStreamsByLanguagePair(streams, "en", "ja").map((stream) => stream.login)).toEqual([
      "both_tags",
      "both_tags_2",
    ]);
  });
});

describe("fetchLanguagePairStreams", () => {
  /**
   * Helix の Get Streams は視聴者数降順の上位 first 件しか返さないため、2言語をまとめて
   * 問い合わせると、視聴者数の多い言語(例: 英語)の大規模配信に埋もれて両タグ配信が
   * 1件も入らない(実データで確認済み)。そのため言語ごとに1リクエストずつ発行し、
   * 結果をマージしてからタグでフィルタする。
   */
  it("放送言語ごとに1リクエストずつ問い合わせ、マージした結果から両タグを含む配信だけを返す", async () => {
    // 英語放送側は両タグ配信なし、日本語放送側に両タグ配信あり、という実態に近い状態を作る
    const enBroadcastJson = {
      data: [
        {
          user_login: "big_english_streamer",
          user_name: "BigEnglishStreamer",
          viewer_count: 50_000,
          tags: ["English"],
        },
      ],
    };
    const jaBroadcastJson = createHelixStreamsJson();
    const fetchFn = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.includes("language=en") ? enBroadcastJson : jaBroadcastJson), {
            status: 200,
          }),
        ),
      );

    const streams = await fetchLanguagePairStreams("en", "ja", { fetchFn });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const requestedUrls = fetchFn.mock.calls.map((call) => call[0] as string);
    expect(requestedUrls[0]).toContain("/api/twitch/streams?");
    expect(requestedUrls[0]).toContain("language=en");
    expect(requestedUrls[0]).toContain("first=100");
    expect(requestedUrls[1]).toContain("language=ja");
    expect(streams?.map((stream) => stream.login)).toEqual(["eigo_sensei"]);
  });

  it("2つの結果に同じ配信が含まれる場合は1件にまとめ、視聴者数の多い順に並べる", async () => {
    // 両言語の結果に重複して現れる配信(dup_streamer)と、視聴者数の異なる両タグ配信を用意する
    const createBothTagStream = (login: string, viewerCount: number) => ({
      user_login: login,
      user_name: login,
      viewer_count: viewerCount,
      tags: ["English", "日本語"],
    });
    const enBroadcastJson = { data: [createBothTagStream("dup_streamer", 300), createBothTagStream("en_side", 100)] };
    const jaBroadcastJson = { data: [createBothTagStream("dup_streamer", 300), createBothTagStream("ja_side", 200)] };
    const fetchFn = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          new Response(JSON.stringify(url.includes("language=en") ? enBroadcastJson : jaBroadcastJson), {
            status: 200,
          }),
        ),
      );

    const streams = await fetchLanguagePairStreams("en", "ja", { fetchFn });

    expect(streams?.map((stream) => stream.login)).toEqual(["dup_streamer", "ja_side", "en_side"]);
  });

  it("HTTP エラー(Helix 未設定の 503 など)の場合は null を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("Service Unavailable", { status: 503 }));
    expect(await fetchLanguagePairStreams("en", "ja", { fetchFn })).toBeNull();
  });

  it("片方のリクエストだけ失敗した場合も null を返す(部分的な一覧を正常時と区別できないため)", async () => {
    const fetchFn = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(
          url.includes("language=en")
            ? new Response(JSON.stringify(createHelixStreamsJson()), { status: 200 })
            : new Response("Too Many Requests", { status: 429 }),
        ),
      );
    expect(await fetchLanguagePairStreams("en", "ja", { fetchFn })).toBeNull();
  });

  it("ネットワークエラーの場合は null を返す", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("network error"));
    expect(await fetchLanguagePairStreams("en", "ja", { fetchFn })).toBeNull();
  });

  it("200 だが data が配列でない(形式不正)場合は null を返す", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: "不正" }), { status: 200 }));
    expect(await fetchLanguagePairStreams("en", "ja", { fetchFn })).toBeNull();
  });

  it("signal を各 fetch へ引き渡す(言語ペア変更時の中断用)", async () => {
    const fetchFn = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    const controller = new AbortController();
    await fetchLanguagePairStreams("en", "ja", { fetchFn, signal: controller.signal });
    expect(fetchFn.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(fetchFn.mock.calls[1][1]).toMatchObject({ signal: controller.signal });
  });
});
