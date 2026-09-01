/**
 * ホームページ(/) = 3カラムのチャット閲覧画面。
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を3列で表示する。
 *
 * - 左列「生IRC」: 受信した発言をそのまま(表示名の色・emote画像付きで)表示する
 * - 中央列「翻訳」: 発言の翻訳を表示する(生成処理は未実装。骨組みのみ)
 * - 右列「解説」: 発言の解説を必要に応じて生成して表示する(生成処理は未実装。骨組みのみ)
 *
 * 翻訳列・解説列は学習のためデフォルトでぼかして表示し、それぞれのトグルで解除できる。
 * 接続状態・受信済み発言はモジュールスコープのストア(chat-connection.ts)が保持する。
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments } from "@/lib/twitch/emotes";
import { useChatConnectionStore } from "@/store/chat-connection";

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
  const connectionState = useChatConnectionStore((state) => state.connectionState);
  const messages = useChatConnectionStore((state) => state.messages);
  const connect = useChatConnectionStore((state) => state.connect);
  const disconnect = useChatConnectionStore((state) => state.disconnect);

  // 翻訳列・解説列のぼかし。学習のため初期状態はどちらもぼかす
  const [translationBlurred, setTranslationBlurred] = useState(true);
  const [explanationBlurred, setExplanationBlurred] = useState(true);

  const handleConnect = useCallback(() => {
    const channel = channelInput.trim();
    if (!channel) return;
    connect(channel);
  }, [channelInput, connect]);

  const connected = isConnectingOrConnected(connectionState);

  return (
    <div className="flex w-full flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-end gap-4">
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
              <Button onClick={disconnect} variant="outline">
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

        <div className="flex items-center gap-2">
          <Switch
            id="translation-blur"
            checked={translationBlurred}
            onCheckedChange={setTranslationBlurred}
            aria-label="翻訳をぼかす"
          />
          <Label htmlFor="translation-blur">翻訳をぼかす</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="explanation-blur"
            checked={explanationBlurred}
            onCheckedChange={setExplanationBlurred}
            aria-label="解説をぼかす"
          />
          <Label htmlFor="explanation-blur">解説をぼかす</Label>
        </div>
      </div>

      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        <Column title="生IRC" blurred={false}>
          <ol className="flex flex-col gap-1 p-4">
            {messages.map((message) => (
              <ChatMessageRow key={message.id ?? `${message.username}-${message.timestampMs}`} message={message} />
            ))}
          </ol>
        </Column>
        <Column title="翻訳" blurred={translationBlurred}>
          <p className="p-4 text-sm text-muted-foreground">翻訳は未実装です。</p>
        </Column>
        <Column title="解説" blurred={explanationBlurred}>
          <p className="p-4 text-sm text-muted-foreground">解説は未実装です。</p>
        </Column>
      </div>
    </div>
  );
}

/** 3カラムのうちの1列。`blurred` が true のあいだ本文をぼかして表示する */
function Column({ title, blurred, children }: { title: string; blurred: boolean; children: React.ReactNode }) {
  return (
    <section
      aria-label={title}
      data-blurred={blurred}
      className="flex flex-col overflow-hidden rounded-xl border bg-card"
    >
      <h2 className="border-b px-4 py-2 text-sm font-semibold">{title}</h2>
      <ScrollArea className="h-[70vh]">
        <div className={cn("transition-[filter]", blurred && "blur-sm select-none")}>{children}</div>
      </ScrollArea>
    </section>
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
