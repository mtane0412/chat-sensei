/**
 * ホームページ(/) = ライブチャット画面。
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を
 * 表示名の色・emote画像付きでリアルタイム表示する。
 * サーバーへの送信は行わず、`irc-client.ts` が直接ブラウザから
 * `wss://irc-ws.chat.twitch.tv` へ接続する。
 *
 * 発言をクリックしてAI解説を生成する機能(手動ピック)は Phase 2 で追加する。
 */
"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createTwitchIrcClient, type ConnectionState, type TwitchIrcClient } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments } from "@/lib/twitch/emotes";

/** チャットに表示する発言の最大保持件数(古いものから捨てるリングバッファ) */
const MAX_DISPLAYED_MESSAGES = 300;

const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  idle: "待機中",
  connecting: "接続中...",
  open: "接続済み",
  reconnecting: "再接続中...",
  closed: "切断済み",
};

/** 接続中とみなす状態(切断ボタンに切り替える基準) */
function isConnectingOrConnected(state: ConnectionState): boolean {
  return state === "connecting" || state === "open" || state === "reconnecting";
}

export default function Home() {
  const [channelInput, setChannelInput] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [messages, setMessages] = useState<TwitchChatMessage[]>([]);
  const clientRef = useRef<TwitchIrcClient | null>(null);

  // クライアントは初回レンダリング時に一度だけ生成する。
  // setState群はReactが安定した参照を保証するため、コールバック内で使っても古いクロージャの問題は起きない。
  const getClient = useCallback((): TwitchIrcClient => {
    if (!clientRef.current) {
      clientRef.current = createTwitchIrcClient({
        onStateChange: (state) => setConnectionState(state),
        onEvent: (event) => {
          if (event.type !== "privmsg") return;
          setMessages((prev) => {
            const next = [...prev, event.message];
            return next.length > MAX_DISPLAYED_MESSAGES
              ? next.slice(next.length - MAX_DISPLAYED_MESSAGES)
              : next;
          });
        },
      });
    }
    return clientRef.current;
  }, []);

  const handleConnect = useCallback(() => {
    const channel = channelInput.trim();
    if (!channel) return;
    setMessages([]);
    getClient().connect(channel);
  }, [channelInput, getClient]);

  const handleDisconnect = useCallback(() => {
    getClient().disconnect();
  }, [getClient]);

  const connected = isConnectingOrConnected(connectionState);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>chat-sensei</CardTitle>
          <CardDescription>
            Twitch のチャンネル名を入力してライブチャットに接続します(ログイン不要)。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="channel-input">チャンネル名</Label>
            <div className="flex gap-2">
              <Input
                id="channel-input"
                placeholder="例: zackrawrr"
                value={channelInput}
                onChange={(e) => setChannelInput(e.target.value)}
                disabled={connected}
              />
              {connected ? (
                <Button onClick={handleDisconnect} variant="outline">
                  切断する
                </Button>
              ) : (
                <Button onClick={handleConnect} disabled={channelInput.trim().length === 0}>
                  接続する
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground" role="status">
              状態: <span>{CONNECTION_STATE_LABEL[connectionState]}</span>
            </p>
          </div>
        </CardContent>
      </Card>

      <Card className="flex flex-1 flex-col overflow-hidden">
        <ScrollArea className="h-[60vh]">
          <ol className="flex flex-col gap-1 p-4">
            {messages.map((message) => (
              <ChatMessageRow key={message.id ?? `${message.username}-${message.timestampMs}`} message={message} />
            ))}
          </ol>
        </ScrollArea>
      </Card>
    </div>
  );
}

function ChatMessageRow({ message }: { message: TwitchChatMessage }) {
  const segments = useMemo(
    () => splitMessageIntoSegments(message.text, message.emotes),
    [message.text, message.emotes],
  );

  return (
    <li className="text-sm leading-relaxed break-words">
      <span className="font-semibold" style={message.color ? { color: message.color } : undefined}>
        {message.displayName}
      </span>
      <span>: </span>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <span key={index}>{segment.text}</span>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- Twitch CDNの外部画像のためnext/imageのドメイン許可設定は不要な単純imgで表示する
          <img
            key={index}
            src={buildEmoteImageUrl(segment.id)}
            alt={segment.text}
            className="mx-0.5 inline-block h-6 align-text-bottom"
          />
        ),
      )}
    </li>
  );
}
