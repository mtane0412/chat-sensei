/**
 * 接続中の画面上半分で配信embed(TwitchEmbedPlayer)の横に置く、配信者情報パネル。
 *
 * - 配信者のアバター(avatars ストア。未取得の間はアバターなし)と表示名
 *   (配信情報が無い間 = オフライン・Helix 利用不可・読み込み中は、接続中のチャンネル名で代用)
 * - 配信タイトル
 * - 配信カテゴリ(ゲーム名)。ゲームIDからボックスアート画像を取得できた場合は画像も表示する
 * - 同時視聴者数(Helix から取得できた場合のみ)。Twitch 本体と同様に、
 *   配信者名の横へ赤色の人アイコン + 桁区切りの数字で表示する
 * - 配信開始からの経過時間(Helix の `started_at` を取得できた場合のみ。1秒ごとに更新)
 * - 配信タグ(取得できた場合のみ、チップのリストで表示)
 * - 接続状態のラベル(Disconnect ボタンは持たない。切断はヘッダーのロゴクリック
 *   (site-header.tsx)で行う)
 *
 * 配信情報は stream-info ストア(接続時に読み込み済み)を購読して表示するだけで、
 * このパネル自身は Helix を呼ばない(例外はボックスアート。ゲームIDが判明したときに
 * `fetchGameBoxArtUrl` で取得し、取得できなければカテゴリ名のテキストのみで表示する)。
 * 配信者のアバターは avatars ストアの共通バッチ取得(`requestAvatar`)へ要求する。
 */
"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { ClockIcon, UserIcon } from "lucide-react";
import type { ConnectionState } from "@/lib/twitch/irc-client";
import { fetchGameBoxArtUrl } from "@/lib/twitch/game-box-art";
import { requestAvatar, useAvatarStore } from "@/store/avatars";
import { useChatConnectionStore } from "@/store/chat-connection";
import { useStreamInfoStore } from "@/store/stream-info";

/** 接続状態の表示ラベル。接続フォーム(page.tsx)とこのパネルで共用する */
export const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting...",
  open: "Connected",
  reconnecting: "Reconnecting...",
  closed: "Disconnected",
};

/** 同時視聴者数の桁区切り表示(UI は英語のためロケールも en-US 固定) */
const VIEWER_COUNT_FORMAT = new Intl.NumberFormat("en-US");

/** 経過時間の再計算間隔。Twitch 本体の稼働時間表示と同様に秒単位で進める */
const UPTIME_TICK_INTERVAL_MS = 1_000;

/**
 * 現在時刻(秒単位)を「外部ストア」として購読するための関数群。
 * レンダー中の `Date.now()` 呼び出し(純粋性ルール違反)と effect 内の同期 setState を
 * 避けるため、useSyncExternalStore で現在時刻を読む。
 */
/** 現在時刻のスナップショット(秒単位。ミリ秒のままだと毎レンダーで値が変わってしまうため丸める) */
function getNowSecondsSnapshot(): number {
  return Math.floor(Date.now() / 1000);
}

/** 1秒ごとに再読み取りを通知する購読関数(配信開始日時がある間だけ使う) */
function subscribeUptimeTick(onTick: () => void): () => void {
  const timerId = setInterval(onTick, UPTIME_TICK_INTERVAL_MS);
  return () => clearInterval(timerId);
}

/** 何も通知しない購読関数(配信開始日時が無い間は tick を回さない) */
function subscribeNothing(): () => void {
  return () => {};
}

/**
 * 配信開始からの経過ミリ秒を `H:MM:SS` 形式(時は桁埋めなし)にする。
 * 端末の時計ずれなどで負になった場合は 0 秒として扱う。
 */
function formatUptime(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function StreamInfoPanel() {
  const channel = useChatConnectionStore((state) => state.channel);
  const connectionState = useChatConnectionStore((state) => state.connectionState);
  const streamInfo = useStreamInfoStore((state) => state.streamInfo);

  // 配信者のアバター。発言者アバターと同じ共通バッチ(avatars ストア)へ取得を要求する
  const broadcasterId = streamInfo?.broadcasterId ?? "";
  const avatarUrl = useAvatarStore((state) => (broadcasterId === "" ? undefined : state.avatars[broadcasterId]));
  useEffect(() => {
    if (broadcasterId !== "") requestAvatar(broadcasterId);
  }, [broadcasterId]);

  // カテゴリのボックスアート。取得できない場合はカテゴリ名のテキストのみで表示する(意図したフォールバック)。
  // 取得元の gameId と対にして保持し、チャンネル切り替えで gameId が変わった直後に
  // 前のゲームのボックスアートを表示しない(描画時に gameId の一致で選別する)
  const gameId = streamInfo?.gameId ?? "";
  const [boxArt, setBoxArt] = useState<{ gameId: string; url: string | null } | null>(null);
  useEffect(() => {
    if (gameId === "") return;
    // アンマウント・gameId 変更後に遅れて届いた結果で state を更新しない
    let cancelled = false;
    void fetchGameBoxArtUrl(gameId).then((url) => {
      if (!cancelled) setBoxArt({ gameId, url });
    });
    return () => {
      cancelled = true;
    };
  }, [gameId]);
  const boxArtUrl = boxArt !== null && boxArt.gameId === gameId ? boxArt.url : null;

  // 配信開始からの経過時間。現在時刻(秒単位)を外部ストアとして購読し、
  // startedAt がある間だけ1秒ごとに再読み取りする。読み込み完了が遅れた場合も、
  // そのレンダーで最新のスナップショットを読むため表示直後から正しい値になる
  const startedAt = streamInfo?.startedAt ?? null;
  const nowSeconds = useSyncExternalStore(
    startedAt !== null ? subscribeUptimeTick : subscribeNothing,
    getNowSecondsSnapshot,
    getNowSecondsSnapshot,
  );
  const uptimeText = startedAt !== null ? formatUptime(nowSeconds * 1000 - Date.parse(startedAt)) : null;

  // 配信情報が無い間(オフライン・Helix 利用不可・読み込み中)は接続中のチャンネル名で代用する
  const displayName =
    streamInfo !== null && streamInfo.broadcasterName !== "" ? streamInfo.broadcasterName : (channel ?? "");

  return (
    <aside aria-label="Stream info" className="flex min-w-0 flex-1 flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-3">
        {avatarUrl !== undefined && (
          // eslint-disable-next-line @next/next/no-img-element -- Twitch CDNの外部画像のためnext/imageのドメイン許可設定は不要な単純imgで表示する
          <img
            src={avatarUrl}
            // 直後に表示名がテキストで続くため、アバターは装飾画像として扱う
            alt=""
            className="size-10 rounded-full"
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold">{displayName}</p>
          <p className="text-xs text-muted-foreground" role="status">
            {CONNECTION_STATE_LABEL[connectionState]}
          </p>
        </div>
        {streamInfo !== null && streamInfo.viewerCount !== null && (
          // Twitch 本体と同様の「赤色の人アイコン + 数字」(色はライブ配信用トークン --live)。
          // 画面には数字のみを表示し、スクリーンリーダーには sr-only の「viewers」で単位を補う
          <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-live">
            <UserIcon aria-hidden="true" className="size-4" />
            <span>
              {VIEWER_COUNT_FORMAT.format(streamInfo.viewerCount)}
              <span className="sr-only"> viewers</span>
            </span>
          </span>
        )}
        {uptimeText !== null && (
          // Twitch 本体と同様の稼働時間表示。画面には時間のみを表示し、
          // スクリーンリーダーには sr-only の「uptime」で意味を補う
          <span className="flex shrink-0 items-center gap-1 text-sm font-medium text-muted-foreground tabular-nums">
            <ClockIcon aria-hidden="true" className="size-4" />
            <span>
              {uptimeText}
              <span className="sr-only"> uptime</span>
            </span>
          </span>
        )}
      </div>
      {streamInfo !== null && (
        <div className="flex min-h-0 flex-1 gap-3">
          {boxArtUrl !== null && (
            // eslint-disable-next-line @next/next/no-img-element -- Twitch CDNの外部画像のためnext/imageのドメイン許可設定は不要な単純imgで表示する
            <img src={boxArtUrl} alt={streamInfo.category} className="h-24 w-18 rounded-md object-cover" />
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-sm break-words">{streamInfo.title}</p>
            {streamInfo.category !== "" && <p className="text-sm text-muted-foreground">{streamInfo.category}</p>}
            {streamInfo.tags.length > 0 && (
              // Twitch 本体と同様のタグチップ。取得できた場合のみ表示する
              <ul aria-label="Stream tags" className="flex flex-wrap gap-1.5 pt-1">
                {streamInfo.tags.map((tag) => (
                  <li
                    key={tag}
                    className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  >
                    {tag}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
