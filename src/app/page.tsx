/**
 * ホームページ(/) = 3カラムのチャット閲覧画面。
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を3列で表示する。
 *
 * - 左列「生IRC」: 受信した発言をそのまま(表示名の色・emote画像付きで)表示する
 * - 中央列「翻訳」: 発言ごとの翻訳(translations ストア)を左列と同じ高さの行に表示する
 * - 右列「Pick up」: 発言ごとに抽出した注目の表現(語句と意味のペア。pickups ストア)を同じ行に表示する
 *
 * 行の高さ揃えは CSS subgrid で実現する。3列の親グリッドが「見出し1行 + 発言数ぶんの行」を
 * 持ち、各列(section)は `grid-rows-subgrid` で親の行トラックを共有する。これにより
 * 同じ発言の左列・中央列・右列のセルが常に同じ行に並び、行の高さは3列の最大値に揃う。
 * スクロールは3列で共通の1つにまとめる(列ごとに独立させると行の対応が崩れるため)。
 *
 * 翻訳列・Pick up列は学習のためデフォルトでぼかして表示し、各列の見出し右端に置いた
 * 目のアイコンのトグル(BlurToggle)で解除できる。
 * 生IRC列の見出しには bot除外設定(BotFilterDialog)を開くアイコンを置く。除外パターンは
 * bot-filter ストアが LocalStorage から復元し、chat-connection ストアが受信時に適用する。
 * 接続状態・受信済み発言はモジュールスコープのストア(chat-connection.ts)が、
 * 翻訳結果は translations ストアが、抽出結果は pickups ストアが保持し、
 * 各パイプラインはこの画面のマウント時に開始する。
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { BotFilterDialog } from "@/components/bot-filter-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments, splitTextByEmoteNames, type MessageSegment } from "@/lib/twitch/emotes";
import { hydrateBotFilterStore } from "@/store/bot-filter";
import { useChatConnectionStore } from "@/store/chat-connection";
import { startPickupPipeline, usePickupStore, warmUpPickupPipeline, type PickupEntry } from "@/store/pickups";
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

  // 翻訳列・Pick up列のぼかし。学習のため初期状態はどちらもぼかす
  const [translationBlurred, setTranslationBlurred] = useState(true);
  const [pickupBlurred, setPickupBlurred] = useState(true);

  const translationEntries = useTranslationStore((state) => state.entries);
  const promptApi = useTranslationStore((state) => state.promptApi);
  const pickupEntries = usePickupStore((state) => state.entries);
  const pickupPromptApi = usePickupStore((state) => state.promptApi);

  // 受信した発言を自動で翻訳・抽出ジョブに流す。アンマウント時は購読を解除し待機中のジョブを中断する
  useEffect(() => startTranslationPipeline(), []);
  useEffect(() => startPickupPipeline(), []);
  // bot除外パターンを LocalStorage から復元する(SSR 中に触れないようマウント後に行う)
  useEffect(() => hydrateBotFilterStore(), []);

  const handleConnect = useCallback(() => {
    const channel = channelInput.trim();
    if (!channel) return;
    // モデル未ダウンロード時の LanguageModel.create() にはユーザー操作が必要なため、クリックの延長で先に生成する
    warmUpTranslationPipeline();
    warmUpPickupPipeline();
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
      </div>

      <ScrollArea className="h-[70vh]">
        <div
          className="grid grid-cols-3 gap-4"
          // 見出し1行 + 発言数ぶんの行。各列は subgrid でこの行トラックを共有する
          style={{ gridTemplateRows: `auto repeat(${messages.length}, auto)` }}
        >
          <Column title="生IRC" blurred={false} headerAction={<BotFilterDialog />}>
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <ChatMessageRow key={messageKey(message, index)} message={message} />
              ))}
            </div>
          </Column>
          <Column
            title="翻訳"
            blurred={translationBlurred}
            headerAction={
              <BlurToggle label="翻訳をぼかす" blurred={translationBlurred} onBlurredChange={setTranslationBlurred} />
            }
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
          <Column
            title="Pick up"
            blurred={pickupBlurred}
            headerAction={<BlurToggle label="Pick upをぼかす" blurred={pickupBlurred} onBlurredChange={setPickupBlurred} />}
            headerExtra={
              pickupPromptApi.status === "unavailable" ? (
                <p className="text-xs font-normal text-destructive">{pickupPromptApi.reason}</p>
              ) : null
            }
          >
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <Row key={messageKey(message, index)} message={message} blurred={pickupBlurred}>
                  <PickupCellContent
                    message={message}
                    entry={message.id === null ? undefined : pickupEntries[message.id]}
                    promptApi={pickupPromptApi}
                  />
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
 * 列のぼかしを切り替える目のアイコンのトグル。列の見出し右端に置く。
 * ぼかし中は EyeOff、解除中は Eye を表示し、`role="switch"` + `aria-checked` で状態を公開する。
 */
function BlurToggle({
  label,
  blurred,
  onBlurredChange,
}: {
  /** スクリーンリーダー向けの名前(例: "翻訳をぼかす") */
  label: string;
  blurred: boolean;
  onBlurredChange: (blurred: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      role="switch"
      aria-checked={blurred}
      aria-label={label}
      onClick={() => onBlurredChange(!blurred)}
    >
      {blurred ? <EyeOffIcon /> : <EyeIcon />}
    </Button>
  );
}

/**
 * 3カラムのうちの1列。親グリッドの行トラックを subgrid で共有し、
 * 1行目に見出し、2行目以降に `children`(display: contents のリスト)の各行を並べる。
 */
function Column({
  title,
  blurred,
  headerExtra,
  headerAction,
  children,
}: {
  title: string;
  /** 列全体がぼかし中か(実際のぼかしは行単位で適用し、ここでは data 属性で状態を公開する) */
  blurred: boolean;
  /** 見出しの下に表示する補足(Prompt API 利用不可の理由など) */
  headerExtra?: React.ReactNode;
  /** 見出しの右端に置く操作(bot除外設定のアイコンなど) */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-blurred={blurred}
      className="grid min-w-0 grid-rows-subgrid row-[1/-1] rounded-xl border bg-card pb-3"
    >
      <div className="sticky top-0 z-10 border-b bg-card px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{title}</h2>
          {headerAction}
        </div>
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
      return <TranslationText message={message} translation={entry.translation} />;
    case "failed":
      return <span className="text-destructive">翻訳に失敗: {entry.reason}</span>;
    case "dropped":
      return <span className="text-muted-foreground">未翻訳(流量超過)</span>;
    case "unavailable":
      return <span className="text-muted-foreground">翻訳不可</span>;
  }
}

/** Pick up列の1行の中身。翻訳列と同様に、生成中・失敗・キュー溢れ・Prompt API 利用不可の各状態を明示する */
function PickupCellContent({
  message,
  entry,
  promptApi,
}: {
  message: TwitchChatMessage;
  entry: PickupEntry | undefined;
  promptApi: PromptApiStatus;
}) {
  if (message.id === null) {
    return <span className="text-muted-foreground">未抽出(IDなし)</span>;
  }
  if (!entry) {
    if (promptApi.status === "unavailable") return <span className="text-muted-foreground">抽出不可</span>;
    if (promptApi.status === "checking") return <span className="text-muted-foreground">準備中...</span>;
    return <span className="text-muted-foreground">未抽出</span>;
  }
  switch (entry.status) {
    case "pending":
      return <span className="text-muted-foreground">抽出中...</span>;
    case "done":
      if (entry.terms.length === 0) return <span className="text-muted-foreground">なし</span>;
      return (
        <dl className="flex flex-col gap-0.5">
          {entry.terms.map((term, index) => (
            <div key={index} className="flex flex-wrap gap-x-2">
              <dt className="font-semibold">{term.term}</dt>
              <dd className="text-muted-foreground">{term.meaning}</dd>
            </div>
          ))}
        </dl>
      );
    case "failed":
      return <span className="text-destructive">抽出に失敗: {entry.reason}</span>;
    case "dropped":
      return <span className="text-muted-foreground">未抽出(流量超過)</span>;
    case "unavailable":
      return <span className="text-muted-foreground">抽出不可</span>;
  }
}

/**
 * 翻訳文の中身。翻訳は emote 名をそのまま残す設計のため、元の発言に含まれていた emote 名が
 * 文字列として現れた箇所を左列と同じ emote 画像に置き換えて表示する(issue #28)
 */
function TranslationText({ message, translation }: { message: TwitchChatMessage; translation: string }) {
  const segments = useMemo(() => {
    const knownEmotes = splitMessageIntoSegments(message.text, message.emotes).filter(
      (segment) => segment.type === "emote",
    );
    return splitTextByEmoteNames(translation, knownEmotes);
  }, [message.text, message.emotes, translation]);

  return (
    <span>
      <MessageSegments segments={segments} />
    </span>
  );
}

/** テキスト/emote セグメント列を、テキストはそのまま・emote は画像として描画する(左列・翻訳列で共通) */
function MessageSegments({ segments }: { segments: MessageSegment[] }) {
  return segments.map((segment, index) =>
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
  );
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
      <MessageSegments segments={segments} />
    </Row>
  );
}
