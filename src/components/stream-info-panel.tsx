/**
 * 接続中の画面上半分で配信embed(TwitchEmbedPlayer)の横に置く、配信者情報パネル。
 *
 * - 配信者のアバター(avatars ストア。未取得の間はアバターなし)と表示名
 *   (配信情報が無い間 = オフライン・Helix 利用不可・読み込み中は、接続中のチャンネル名で代用)
 * - 配信タイトル
 * - 配信カテゴリ(ゲーム名)。ゲームIDからボックスアート画像を取得できた場合は画像も表示する
 * - 同時視聴者数(Helix から取得できた場合のみ)
 * - 接続状態のラベルと Disconnect ボタン
 *
 * 配信情報は stream-info ストア(接続時に読み込み済み)を購読して表示するだけで、
 * このパネル自身は Helix を呼ばない(例外はボックスアート。ゲームIDが判明したときに
 * `fetchGameBoxArtUrl` で取得し、取得できなければカテゴリ名のテキストのみで表示する)。
 * 配信者のアバターは avatars ストアの共通バッチ取得(`requestAvatar`)へ要求する。
 */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
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

export function StreamInfoPanel() {
  const channel = useChatConnectionStore((state) => state.channel);
  const connectionState = useChatConnectionStore((state) => state.connectionState);
  const disconnect = useChatConnectionStore((state) => state.disconnect);
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
        <Button onClick={disconnect} variant="outline" size="sm">
          Disconnect
        </Button>
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
            {streamInfo.viewerCount !== null && (
              <p className="text-sm text-muted-foreground">
                {VIEWER_COUNT_FORMAT.format(streamInfo.viewerCount)} viewers
              </p>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
