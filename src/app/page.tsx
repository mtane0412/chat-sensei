/**
 * ホームページ(/) = 3カラムのチャット閲覧画面。
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を3列で表示する。
 *
 * - 左列「生IRC」: 受信した発言をそのまま(表示名の色・emote画像付きで)表示する
 * - 中央列「翻訳」: 発言ごとの翻訳(translations ストア)を左列と同じ高さの行に表示する
 * - 右列「解説」: 発言の解説を必要に応じて生成して表示する(生成処理は未実装。骨組みのみ)
 *
 * 行の高さ揃えは CSS subgrid で実現する。3列の親グリッドが「見出し1行 + 発言数ぶんの行」を
 * 持ち、各列(section)は `grid-rows-subgrid` で親の行トラックを共有する。これにより
 * 同じ発言の左列・中央列・右列のセルが常に同じ行に並び、行の高さは3列の最大値に揃う。
 * スクロールは3列で共通の1つにまとめる(列ごとに独立させると行の対応が崩れるため)。
 *
 * 翻訳列・解説列は学習のためデフォルトでぼかして表示し、それぞれのトグルで解除できる。
 * 接続状態・受信済み発言はモジュールスコープのストア(chat-connection.ts)が、
 * 翻訳結果は translations ストアが保持し、翻訳パイプラインはこの画面のマウント時に開始する。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  startTranslationPipeline,
  useTranslationStore,
  warmUpTranslationPipeline,
  type PromptApiStatus,
  type TranslationEntry,
} from "@/store/translations";

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

  const translationEntries = useTranslationStore((state) => state.entries);
  const promptApi = useTranslationStore((state) => state.promptApi);

  // 受信した発言を自動で翻訳ジョブに流す。アンマウント時は購読を解除し待機中のジョブを中断する
  useEffect(() => startTranslationPipeline(), []);

  const handleConnect = useCallback(() => {
    const channel = channelInput.trim();
    if (!channel) return;
    // モデル未ダウンロード時の LanguageModel.create() にはユーザー操作が必要なため、クリックの延長で先に生成する
    warmUpTranslationPipeline();
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

      <ScrollArea className="h-[70vh]">
        <div
          className="grid grid-cols-3 gap-4"
          // 見出し1行 + 発言数ぶんの行。各列は subgrid でこの行トラックを共有する
          style={{ gridTemplateRows: `auto repeat(${messages.length}, auto)` }}
        >
          <Column title="生IRC" blurred={false}>
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <ChatMessageRow key={messageKey(message, index)} message={message} />
              ))}
            </div>
          </Column>
          <Column
            title="翻訳"
            blurred={translationBlurred}
            headerExtra={
              promptApi.status === "unavailable" ? (
                <p className="text-xs font-normal text-destructive">{promptApi.reason}</p>
              ) : null
            }
          >
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <Row key={messageKey(message, index)} message={message} blurred={translationBlurred}>
                  <TranslationCellContent
                    message={message}
                    entry={message.id === null ? undefined : translationEntries[message.id]}
                    promptApi={promptApi}
                  />
                </Row>
              ))}
            </div>
          </Column>
          <Column title="解説" blurred={explanationBlurred}>
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <Row key={messageKey(message, index)} message={message} blurred={explanationBlurred}>
                  <span className="text-muted-foreground">解説は未実装です。</span>
                </Row>
              ))}
            </div>
          </Column>
        </div>
      </ScrollArea>
    </div>
  );
}

/** 3列で同じ発言を同じ key で描画するための共通キー。ID が無い発言は位置で代用する */
function messageKey(message: TwitchChatMessage, index: number): string {
  return message.id ?? `no-id-${message.username}-${message.timestampMs}-${index}`;
}

/**
 * 3カラムのうちの1列。親グリッドの行トラックを subgrid で共有し、
 * 1行目に見出し、2行目以降に `children`(display: contents のリスト)の各行を並べる。
 */
function Column({
  title,
  blurred,
  headerExtra,
  children,
}: {
  title: string;
  /** 列全体がぼかし中か(実際のぼかしは行単位で適用し、ここでは data 属性で状態を公開する) */
  blurred: boolean;
  /** 見出しの下に表示する補足(Prompt API 利用不可の理由など) */
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-blurred={blurred}
      className="grid min-w-0 grid-rows-subgrid row-[1/-1] rounded-xl border bg-card pb-3"
    >
      <div className="sticky top-0 z-10 border-b bg-card px-4 py-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {headerExtra}
      </div>
      {children}
    </section>
  );
}

/** 各列の1行。同じ発言の行が3列で同じ高さになるよう、行単位でぼかしを適用する */
function Row({
  message,
  blurred,
  children,
}: {
  message: TwitchChatMessage;
  blurred: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      role="listitem"
      data-message-id={message.id ?? undefined}
      className={cn(
        "px-4 py-1 text-sm leading-relaxed break-words transition-[filter]",
        blurred && "blur-sm select-none",
      )}
    >
      {children}
    </div>
  );
}

/** 翻訳列の1行の中身。生成中・失敗・キュー溢れ・Prompt API 利用不可の各状態を暗黙に隠さず明示する */
function TranslationCellContent({
  message,
  entry,
  promptApi,
}: {
  message: TwitchChatMessage;
  entry: TranslationEntry | undefined;
  promptApi: PromptApiStatus;
}) {
  if (message.id === null) {
    return <span className="text-muted-foreground">未翻訳(IDなし)</span>;
  }
  if (!entry) {
    if (promptApi.status === "unavailable") return <span className="text-muted-foreground">翻訳不可</span>;
    if (promptApi.status === "checking") return <span className="text-muted-foreground">準備中...</span>;
    return <span className="text-muted-foreground">未翻訳</span>;
  }
  switch (entry.status) {
    case "pending":
      return <span className="text-muted-foreground">翻訳中...</span>;
    case "done":
      return <span>{entry.translation}</span>;
    case "failed":
      return <span className="text-destructive">翻訳に失敗: {entry.reason}</span>;
    case "dropped":
      return <span className="text-muted-foreground">未翻訳(流量超過)</span>;
    case "unavailable":
      return <span className="text-muted-foreground">翻訳不可</span>;
  }
}

function ChatMessageRow({ message }: { message: TwitchChatMessage }) {
  const segments = useMemo(
    () => splitMessageIntoSegments(message.text, message.emotes),
    [message.text, message.emotes],
  );

  return (
    <Row message={message} blurred={false}>
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
    </Row>
  );
}
