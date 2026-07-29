/**
 * Twitch公式の埋め込みプレイヤー(`https://player.twitch.tv/`)をiframeで表示するコンポーネント。
 *
 * Twitch embedはブラウザの `Referer`/`postMessage` オリジンをホスト側で検証するため、
 * `parent` クエリパラメータに埋め込み先のホスト名(`window.location.hostname`)を渡す必要がある。
 * ブラウザの自動再生ポリシー(ミュートなし動画の自動再生ブロック)を回避するため、既定でミュート再生する。
 *
 * `window` はサーバー側レンダリング時に存在しないため、`useSyncExternalStore` を使い
 * サーバーでは`null`、クライアントでは`window.location.hostname`を返すことで、
 * hydrationミスマッチを起こさずにホスト名を取得する。
 */
"use client";

import { useSyncExternalStore } from "react";

const TWITCH_PLAYER_BASE_URL = "https://player.twitch.tv/";

interface TwitchEmbedPlayerProps {
  /** 表示するTwitchチャンネル名(正規化済みを想定) */
  channel: string;
}

/** ホスト名はレンダー中に変化しないため、購読不要(何もしないunsubscribeを返す) */
function subscribeToHostname(): () => void {
  return () => {};
}

function getHostnameSnapshot(): string {
  return window.location.hostname;
}

function getServerHostnameSnapshot(): null {
  return null;
}

export function TwitchEmbedPlayer({ channel }: TwitchEmbedPlayerProps) {
  const hostname = useSyncExternalStore(subscribeToHostname, getHostnameSnapshot, getServerHostnameSnapshot);

  if (hostname === null) return null;

  const src = new URL(TWITCH_PLAYER_BASE_URL);
  src.searchParams.set("channel", channel);
  src.searchParams.set("parent", hostname);
  src.searchParams.set("muted", "true");

  return (
    <iframe
      src={src.toString()}
      title={`Twitch配信プレイヤー: ${channel}`}
      allowFullScreen
      // Twitch embedの推奨最小サイズ(400x300px)を狭い画面でも下回らないようmin-h/min-wを設定する
      className="aspect-video w-full min-h-[300px] min-w-[300px]"
    />
  );
}
