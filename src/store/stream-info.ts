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
 */
import { create } from "zustand";
import { fetchStreamInfo, type StreamInfo } from "@/lib/twitch/stream-info";

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
 * 読み込み中にチャンネルが切り替わった場合(クリア・別チャンネルの読み込み開始)は、
 * 遅れて届いた結果を破棄する。取得できない場合は null のまま(文脈なしで動作する)。
 */
export async function loadStreamInfo(
  channelLogin: string,
  fetchInfo: (userLogin: string) => Promise<StreamInfo | null> = fetchStreamInfo,
): Promise<void> {
  const requestGeneration = ++generation;

  const info = await fetchInfo(channelLogin);

  if (generation !== requestGeneration) return;
  if (info === null) return;
  useStreamInfoStore.setState({ streamInfo: info });
}

/** 配信情報を破棄して null に戻す。チャンネル切り替え・切断時に呼ぶ */
export function clearStreamInfo(): void {
  generation += 1;
  useStreamInfoStore.setState({ streamInfo: null });
}

/** テスト専用: モジュールスコープの状態を初期状態に戻す。各テストの afterEach で呼び出すこと */
export function resetStreamInfoForTests(): void {
  clearStreamInfo();
}
