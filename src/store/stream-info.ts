/**
 * 接続中チャンネルの配信情報(タイトル・カテゴリ)を保持する Zustand ストア(issue #54)。
 *
 * `chat-connection.ts` の connect() でチャンネル名(user_login)から読み込み、
 * 翻訳・Pick up のパイプライン(`translations.ts` / `pickups.ts`)がベースセッション生成時に
 * `getStreamInfo` で同期的に参照してシステムプロンプトへ注入する。
 *
 * cheermotes / third-party-emotes と異なり Zustand ストアで持つのは、ホーム画面(page.tsx)が
 * 配信情報の変化(読み込み完了・チャンネル切り替え)を購読してパイプラインを再起動する必要が
 * あるため(システムプロンプトはベースセッションに焼き込まれるため、言語設定の変更と同じく
 * プールを作り直さないと反映されない)。
 *
 * - 取得できない場合(オフライン・Helix 未設定・API 失敗 = null)は null のまま、
 *   文脈なしの現行プロンプトで動作する(意図したフォールバック)
 * - チャンネル切り替え(`connect()`)・切断時は `clearStreamInfo` で破棄し、
 *   読み込み途中だった前チャンネルの結果は世代番号の比較で捨てる
 * - 接続中は定期リフレッシュ(issue #85)で視聴者数・タイトル・カテゴリの変化と
 *   配信終了(オフラインを連続で確認したらクリア)に追従する。API 失敗時は既存の情報を保持する
 */
import { create } from "zustand";
import { fetchStreamInfoResult, type StreamInfo, type StreamInfoFetchResult } from "@/lib/twitch/stream-info";

/** 定期リフレッシュ(issue #85)の実行間隔。視聴者数・カテゴリの変化をこの間隔で追従する */
const STREAM_INFO_REFRESH_INTERVAL_MS = 60_000;

/**
 * offline(配信終了)と判断して配信情報をクリアするまでに必要な連続 offline 回数。
 * Helix Get Streams は配信中でも一時的に空の data を返すことがあり(配信開始直後・
 * レプリケーション遅延)、1回で即クリアするとパイプラインが2回全再起動されて
 * 生成済みの翻訳をすべて失うため、連続で確認してからクリアする
 */
const OFFLINE_CONFIRMATION_COUNT = 2;

/** offline の連続回数。live の取得成功・チャンネル切り替え(クリア)でリセットする */
let consecutiveOfflineCount = 0;

interface StreamInfoState {
  /** 接続中チャンネルの配信情報。未読み込み・オフライン・取得失敗時は null(文脈なしで動作) */
  streamInfo: StreamInfo | null;
}

export const useStreamInfoStore = create<StreamInfoState>(() => ({ streamInfo: null }));

/** クリア・読み込み開始のたびに進める世代番号。読み込み完了時に世代が変わっていたら結果を破棄する */
let generation = 0;

/** 現在の配信情報を返す。未読み込み・オフライン・取得失敗時は null */
export function getStreamInfo(): StreamInfo | null {
  return useStreamInfoStore.getState().streamInfo;
}

/**
 * 指定したチャンネル(正規化済みの user_login)の配信情報を読み込む。
 * `chat-connection.ts` の connect() から初回読み込みとして呼ぶ(取得失敗時は警告を出す)。
 * 更新の判定・世代ガードは `refreshStreamInfo` に委譲する。
 */
export async function loadStreamInfo(
  channelLogin: string,
  fetchResult: (userLogin: string) => Promise<StreamInfoFetchResult> = (userLogin) =>
    fetchStreamInfoResult(userLogin, fetch, { subject: "配信情報", fallback: "文脈なしで動作します" }),
): Promise<void> {
  await refreshStreamInfo(() => fetchResult(channelLogin));
}

/** 2つの配信情報の内容が同じかを比較する。同じ場合は setState を省き、無駄な再レンダリングを避ける */
function isSameStreamInfo(a: StreamInfo | null, b: StreamInfo): boolean {
  return (
    a !== null &&
    a.title === b.title &&
    a.category === b.category &&
    a.broadcasterId === b.broadcasterId &&
    a.broadcasterLogin === b.broadcasterLogin &&
    a.broadcasterName === b.broadcasterName &&
    a.gameId === b.gameId &&
    a.viewerCount === b.viewerCount
  );
}

/**
 * 保持中の配信情報を最新の取得結果で更新する(初回読み込み・定期リフレッシュ共通。issue #85)。
 *
 * - live: 配信情報を置き換える(視聴者数・タイトル・カテゴリの変化を反映する)。
 *   内容が前回と同一なら更新しない(60秒ごとの無駄な再レンダリングを避ける)
 * - offline: 連続 OFFLINE_CONFIRMATION_COUNT 回で配信情報をクリアする
 *   (配信終了後にライブ風の視聴者数を残さない。1回では Helix の一時的な空レスポンスの可能性があるため保持)
 * - unavailable(API 失敗): 既存の配信情報を保持する(リフレッシュの失敗で文脈を失わない)
 *
 * リクエストごとに世代番号を採番し、取得中にチャンネル切り替え・切断・後続リクエストの開始が
 * あった場合(= 世代が進んだ場合)は、遅れて届いた結果を破棄する(古い結果による上書きを防ぐ)。
 */
export async function refreshStreamInfo(fetchResult: () => Promise<StreamInfoFetchResult>): Promise<void> {
  const requestGeneration = ++generation;

  const result = await fetchResult();

  if (generation !== requestGeneration) return;
  if (result.status === "unavailable") return;
  if (result.status === "offline") {
    consecutiveOfflineCount += 1;
    if (consecutiveOfflineCount < OFFLINE_CONFIRMATION_COUNT) return;
    if (useStreamInfoStore.getState().streamInfo !== null) useStreamInfoStore.setState({ streamInfo: null });
    return;
  }
  consecutiveOfflineCount = 0;
  if (isSameStreamInfo(useStreamInfoStore.getState().streamInfo, result.info)) return;
  useStreamInfoStore.setState({ streamInfo: result.info });
}

/** 定期リフレッシュのタイマー。未開始・停止中は null */
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * 指定したチャンネル(正規化済みの user_login)の配信情報の定期リフレッシュを開始する。
 * `chat-connection.ts` の connect() から呼ぶ。既に動いているタイマーがあれば止めて
 * 新しいチャンネルで開始する(チャンネル切り替え)。初回の取得は `loadStreamInfo` が
 * 担うため、ここでは1周期後から更新を始める。
 */
export function startStreamInfoRefresh(
  channelLogin: string,
  fetchResult: (userLogin: string) => Promise<StreamInfoFetchResult> = fetchStreamInfoResult,
): void {
  stopStreamInfoRefresh();
  refreshTimer = setInterval(() => {
    void refreshStreamInfo(() => fetchResult(channelLogin));
  }, STREAM_INFO_REFRESH_INTERVAL_MS);
}

/** 配信情報の定期リフレッシュを停止する。`chat-connection.ts` の disconnect() から呼ぶ */
export function stopStreamInfoRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/** 配信情報を破棄して null に戻す。チャンネル切り替え・切断時に呼ぶ */
export function clearStreamInfo(): void {
  generation += 1;
  // 前チャンネルの offline 連続回数を新チャンネルに持ち越さない
  consecutiveOfflineCount = 0;
  useStreamInfoStore.setState({ streamInfo: null });
}

/** テスト専用: モジュールスコープの状態(保持中の配信情報・定期リフレッシュのタイマー)を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetStreamInfoForTests(): void {
  stopStreamInfoRefresh();
  clearStreamInfo();
}
