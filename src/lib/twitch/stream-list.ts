/**
 * 言語ペアの両タグを含むライブ配信一覧の取得(issue #90)。
 *
 * Helix の Get Streams API(`GET /streams?language=&first=`)を Next.js プロキシ
 * (`/api/twitch/`)経由で呼び、選択中の言語ペア(学習言語・解説言語)の両方の
 * 言語タグを付けたライブ配信の一覧を取得する。ウェルカム画面の配信一覧
 * (`src/components/stream-list.tsx`)が利用する。
 *
 * - Helix はタグでのサーバーサイド絞り込みを提供しない(旧 `tag_ids` パラメータは廃止済み)ため、
 *   `language` パラメータ(繰り返し指定可)で放送言語により母数を絞り、レスポンスの
 *   `tags` 配列をクライアント側で照合する
 * - タグは配信者の自由入力文字列のため、言語ごとにタグ候補語の対応表
 *   (`LANGUAGE_TAG_KEYWORDS`)を持ち、大文字小文字を無視してタグ全体と照合する
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害・ネットワーク
 *   エラー・中断は null を返し、呼び出し側は一覧セクションを表示しない
 *   (チャンネルオートコンプリートと同じ静かなフォールバック。意図した仕様)
 */

import type { SupportedLanguage } from "@/lib/ai/prompts";
import { extractDataArray, fetchHelixJson } from "./helix-proxy";

/** 言語ペアタグ付き配信一覧の 1 件(Helix Get Streams API の 1 項目) */
export interface TaggedStream {
  /** 接続に使うログイン名(Helix の `user_login`) */
  login: string;
  /** 表示名(Helix の `user_name`。日本語名など)。無ければ login と同じ値 */
  displayName: string;
  /** 配信タイトル(Helix の `title`)。無ければ空文字 */
  title: string;
  /** 配信カテゴリ = ゲーム名(Helix の `game_name`)。無ければ空文字 */
  category: string;
  /** 同時視聴者数(Helix の `viewer_count`)。無ければ null(表示しないだけ) */
  viewerCount: number | null;
  /** サムネイル URL(Helix の `thumbnail_url` のサイズプレースホルダを置換済み)。無ければ空文字 */
  thumbnailUrl: string;
  /** 配信者が付けたタグ(Helix の `tags`。自由入力文字列、最大10個)。無ければ空配列 */
  tags: string[];
}

/** サムネイル URL の `{width}x{height}` プレースホルダに埋めるサイズ(カード表示用の 16:9) */
const THUMBNAIL_WIDTH = 440;
const THUMBNAIL_HEIGHT = 248;

/** 1 回の取得で問い合わせる配信の最大件数(Helix の `first` パラメータの上限) */
const STREAM_FETCH_LIMIT = 100;

/**
 * 言語ごとのタグ候補語(すべて小文字)。タグは配信者の自由入力文字列のため、
 * 英語名・ネイティブ表記・アクセント無し表記の表記ゆれを吸収する。
 * 照合はタグ全体との一致のみ(部分一致にすると "LearnJapanese" のような
 * 学習者向けタグを「日本語で配信中」と誤認するため)。
 */
const LANGUAGE_TAG_KEYWORDS: Record<SupportedLanguage, readonly string[]> = {
  en: ["english"],
  ja: ["japanese", "日本語"],
  es: ["spanish", "español", "espanol"],
  de: ["german", "deutsch"],
  fr: ["french", "français", "francais"],
};

/**
 * Helix の Get Streams API レスポンス(`{data: [{user_login, user_name, title, game_name,
 * viewer_count, thumbnail_url, tags, ...}]}`)を解析して配信一覧を作る。
 * `data` が配列でない(形式不正)場合は null を返す(取得失敗と同じ扱いにする)。
 * `user_login` が無い項目・型が想定と異なる項目は読み飛ばし、任意フィールドは
 * 欠けたぶんだけデフォルト値(空文字・null・空配列)で埋める(表示しないだけで一覧としては成立する)。
 */
export function parseTaggedStreams(json: unknown): TaggedStream[] | null {
  const data = extractDataArray(json);
  if (data === null) return null;

  const streams: TaggedStream[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.user_login !== "string" || record.user_login === "") continue;

    streams.push({
      login: record.user_login,
      displayName:
        typeof record.user_name === "string" && record.user_name !== ""
          ? record.user_name
          : record.user_login,
      title: typeof record.title === "string" ? record.title : "",
      category: typeof record.game_name === "string" ? record.game_name : "",
      viewerCount: typeof record.viewer_count === "number" ? record.viewer_count : null,
      thumbnailUrl:
        typeof record.thumbnail_url === "string"
          ? record.thumbnail_url
              .replace("{width}", String(THUMBNAIL_WIDTH))
              .replace("{height}", String(THUMBNAIL_HEIGHT))
          : "",
      // 実際の Helix レスポンスに同じタグの重複がありうる(そのまま表示すると React の key が重複する)ため、
      // 文字列だけ残したうえで最初の1つだけに重複排除する
      tags: Array.isArray(record.tags)
        ? [...new Set(record.tags.filter((tag): tag is string => typeof tag === "string"))]
        : [],
    });
  }
  return streams;
}

/** タグ一覧に指定言語のタグ候補語(大文字小文字無視・タグ全体一致)が含まれるか */
export function streamHasLanguageTag(tags: readonly string[], language: SupportedLanguage): boolean {
  const keywords = LANGUAGE_TAG_KEYWORDS[language];
  return tags.some((tag) => keywords.includes(tag.toLowerCase()));
}

/** 学習言語と解説言語の両方のタグを含む配信だけを、元の順序(Helix の視聴者数降順)を保って残す */
export function filterStreamsByLanguagePair(
  streams: readonly TaggedStream[],
  learningLang: SupportedLanguage,
  explainLang: SupportedLanguage,
): TaggedStream[] {
  return streams.filter(
    (stream) => streamHasLanguageTag(stream.tags, learningLang) && streamHasLanguageTag(stream.tags, explainLang),
  );
}

/** 指定した放送言語のライブ配信の上位 STREAM_FETCH_LIMIT 件を取得する。取得失敗・形式不正は null */
async function fetchStreamsByBroadcastLanguage(
  language: SupportedLanguage,
  signal: AbortSignal | undefined,
  fetchFn: typeof fetch,
): Promise<TaggedStream[] | null> {
  const params = new URLSearchParams();
  params.append("language", language);
  params.append("first", String(STREAM_FETCH_LIMIT));
  // failureLog を渡さない = 失敗しても console.warn しない(中断・障害を一覧非表示として静かに扱う)
  const json = await fetchHelixJson("streams", { params, fetchFn, signal });
  if (json === null) return null;
  return parseTaggedStreams(json);
}

/**
 * Helix プロキシ(`/api/twitch/streams`)から、言語ペアの両タグを含むライブ配信の
 * 一覧を取得する。タグ照合はクライアント側で行う(Helix はタグでの絞り込みを提供しないため)。
 *
 * Get Streams は視聴者数降順の上位 `first` 件しか返さないため、2言語をまとめて
 * 1リクエストで問い合わせると、視聴者数の多い言語(例: 英語)の大規模配信が上位を
 * 占めて両タグ配信が1件も入らない(実データで確認済み)。そのため放送言語ごとに
 * 1リクエストずつ発行し(どちらの言語で放送していても両タグ付きなら対象にする)、
 * 重複を除いてマージした結果を視聴者数の多い順に並べてからタグでフィルタする。
 *
 * 取得できない場合は null を返す(呼び出し側は一覧セクションを表示しない。意図した仕様):
 * - Helix 未設定(プロキシが 503 を返す)・レート制限・障害などの HTTP エラー
 * - ネットワークエラー・`signal` による中断(AbortError)
 * - 200 だが `data` が配列でない(形式不正)ボディ
 * - いずれか片方のリクエストだけ失敗した場合(部分的な一覧を正常時と区別できないため)
 *
 * 前提条件: learningLang と explainLang は異なる言語であること(同一言語ペアは
 * 設定スキーマ(`lib/settings.ts` の settingsSchema)が保存時点で拒否するため発生しない。
 * 同値の場合の重複リクエスト排除は意図的に実装していない)。
 */
export async function fetchLanguagePairStreams(
  learningLang: SupportedLanguage,
  explainLang: SupportedLanguage,
  options: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<TaggedStream[] | null> {
  const { signal, fetchFn = fetch } = options;
  const [learningSide, explainSide] = await Promise.all([
    fetchStreamsByBroadcastLanguage(learningLang, signal, fetchFn),
    fetchStreamsByBroadcastLanguage(explainLang, signal, fetchFn),
  ]);
  if (learningSide === null || explainSide === null) return null;

  // 両言語の結果に同じ配信が現れうる(放送言語は1つだが上位に重なるケースを保険で除く)ため login で重複を除く
  const mergedByLogin = new Map<string, TaggedStream>();
  for (const stream of [...learningSide, ...explainSide]) {
    if (!mergedByLogin.has(stream.login)) mergedByLogin.set(stream.login, stream);
  }
  // 2つの結果(それぞれ視聴者数降順)を混ぜたため、全体を視聴者数の多い順に並べ直す(視聴者数不明は末尾)
  const merged = [...mergedByLogin.values()].sort(
    (a, b) => (b.viewerCount ?? -1) - (a.viewerCount ?? -1),
  );
  return filterStreamsByLanguagePair(merged, learningLang, explainLang);
}
