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
 * 翻訳列・Pick up列は各列の見出し右端に置いた目のアイコンのトグル(BlurToggle)でぼかせる
 * (自力で読む練習をしたいときに使う。初期状態はどちらも見える)。
 * 生IRC列の見出しには、新着発言に合わせてスクロール領域を最下部へ送り続ける追従トグル(FollowToggle。
 * 初期状態はオンで、利用者が上へスクロールして最下部から離れると自動でオフになる)と、
 * 学ぶ言語(LearningLanguagesDialog。複数選択可)、bot除外設定(BotFilterDialog)を開くアイコンを置く。
 * 翻訳列の見出しには解説言語(ExplanationLanguageDialog)を開くアイコンを置く。言語は配信ごとに異なるため、
 * アプリ全体の設定(歯車)ではなく対象の列から切り替える。除外パターンは
 * bot-filter ストアが LocalStorage から復元し、chat-connection ストアが受信時に適用する。
 * 接続状態・受信済み発言はモジュールスコープのストア(chat-connection.ts)が、
 * 翻訳結果は translations ストアが、抽出結果は pickups ストアが保持し、
 * 各パイプラインはこの画面のマウント時に開始する。Prompt API の利用可否は両列で共通の
 * prompt-api ストアを参照し、利用不可の理由は翻訳列・Pick up列それぞれの見出し下に表示する。
 * 接続フォームの横には設定ダイアログ(SettingsDialog。環境診断と設定の初期化)を開くアイコンを置く。
 * 言語設定は settings ストアが LocalStorage から復元し、パイプラインは復元後に開始する。言語設定が変わると
 * 両パイプラインを停止して新しい設定で開始し直す(生成済みの翻訳・Pick up は破棄され、表示中の発言は再生成される)。
 * 発言ごとの言語判定で処理しなかった行(解説言語と同じ / 学ぶ言語ではない)は、その旨を各列に表示する。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { BotFilterDialog } from "@/components/bot-filter-dialog";
import { ExplanationLanguageDialog, LearningLanguagesDialog } from "@/components/language-dialogs";
import { SettingsDialog } from "@/components/settings-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { ConnectionState } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments, type MessageSegment } from "@/lib/twitch/emotes";
import { hydrateBotFilterStore } from "@/store/bot-filter";
import { useChatConnectionStore } from "@/store/chat-connection";
import type { PipelineEntry } from "@/store/auto-pipeline";
import { startPickupPipeline, usePickupStore, warmUpPickupPipeline, type PickupDone } from "@/store/pickups";
import { usePromptApiStore, type PromptApiStatus } from "@/store/prompt-api";
import { hydrateSettingsStore, useSettingsStore } from "@/store/settings";
import { useStreamInfoStore } from "@/store/stream-info";
import {
  startTranslationPipeline,
  useTranslationStore,
  warmUpTranslationPipeline,
  type TranslationDone,
} from "@/store/translations";

const CONNECTION_STATE_LABEL: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting...",
  open: "Connected",
  reconnecting: "Reconnecting...",
  closed: "Disconnected",
};

/** 翻訳列・Pick up 列の行に表示する状態文言。列ごとに動詞が異なるため文言一式で受け取る */
interface PipelineCellLabels {
  /** 未処理(例: "Not translated") */
  notYet: string;
  /** 処理中(例: "Translating...") */
  pending: string;
  /** 失敗(例: "Translation failed") */
  failed: string;
  /** Prompt API 利用不可(例: "Translation unavailable") */
  unavailable: string;
}

const TRANSLATION_LABELS: PipelineCellLabels = {
  notYet: "Not translated",
  pending: "Translating...",
  failed: "Translation failed",
  unavailable: "Translation unavailable",
};

const PICKUP_LABELS: PipelineCellLabels = {
  notYet: "Not extracted",
  pending: "Extracting...",
  failed: "Extraction failed",
  unavailable: "Extraction unavailable",
};

/** 最下部からこの距離(px)を超えて上へスクロールしたら、新着への追従を自動でオフにする(サブピクセル誤差の吸収用) */
const FOLLOW_RELEASE_THRESHOLD_PX = 4;

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

  // 翻訳列・Pick up列のぼかし。初期状態はどちらも見える(自力で読みたいときに利用者がぼかす)
  const [translationBlurred, setTranslationBlurred] = useState(false);
  const [pickupBlurred, setPickupBlurred] = useState(false);

  // 新着発言への追従。オンの間は発言が増えるたびにスクロール領域を最下部へ送る
  const [followLatest, setFollowLatest] = useState(true);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!followLatest) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [followLatest, messages]);
  // 利用者が上方向へスクロールして最下部から離れたら、読み返しの邪魔をしないよう追従を自動でオフにする。
  // 追従による最下部へのスクロールもこのイベントを起こすが、その時点では最下部にいるためオフにはならない
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const handleScroll = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distanceFromBottom > FOLLOW_RELEASE_THRESHOLD_PX) setFollowLatest(false);
    };
    viewport.addEventListener("scroll", handleScroll);
    return () => viewport.removeEventListener("scroll", handleScroll);
  }, []);

  const translationEntries = useTranslationStore((state) => state.entries);
  const pickupEntries = usePickupStore((state) => state.entries);
  // Prompt API の利用可否は翻訳列・Pick up列で共通(環境診断は1回だけ実行する)
  const promptApi = usePromptApiStore((state) => state.status);

  // 言語ペア・bot除外パターンを LocalStorage から復元する(SSR 中に触れないようマウント後に行う)
  useEffect(() => hydrateSettingsStore(), []);
  useEffect(() => hydrateBotFilterStore(), []);

  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const settings = useSettingsStore((state) => state.settings);
  // 言語設定・LLM プロバイダ設定の内容が変わったときだけパイプラインを再起動するため、値を文字列にして依存に使う
  // (`setSettings` は同じ内容でも新しいオブジェクトを作るため、参照比較では再起動してしまう)。
  // LLM 設定はセッションプールの生成(どのプロバイダ・モデル・キーで作るか)に影響するため含める
  const settingsKey = [
    settings.learningLangs.join(","),
    settings.explainLang,
    settings.llmProvider,
    settings.openRouterApiKey,
    settings.openRouterModel,
  ].join("|");

  // 配信の文脈(タイトル・カテゴリ。issue #54)はセッションプールのシステムプロンプトに焼き込むため、
  // 読み込み完了・チャンネル切り替えで内容が変わったときもパイプラインを再起動して反映する
  // (言語設定の変更と同じ機構。生成済みの翻訳・Pick up は破棄され、表示中の発言は再生成される)
  const streamInfo = useStreamInfoStore((state) => state.streamInfo);
  const streamInfoKey =
    streamInfo === null
      ? ""
      : [streamInfo.title, streamInfo.category, streamInfo.broadcasterLogin, streamInfo.broadcasterName].join("|");

  // 受信した発言を自動で翻訳・抽出ジョブに流す。言語設定の復元後に開始し、言語設定が変わるたびに
  // 停止 → 開始し直す(セッションプールのシステムプロンプトに言語ペアを含むため)。
  // 変更時に既に接続済みなら、設定の保存というユーザー操作の延長でセッションを先に生成しておく
  useEffect(() => {
    if (!settingsHydrated) return;
    const stop = startTranslationPipeline();
    if (isConnectingOrConnected(useChatConnectionStore.getState().connectionState)) warmUpTranslationPipeline();
    return stop;
  }, [settingsHydrated, settingsKey, streamInfoKey]);
  useEffect(() => {
    if (!settingsHydrated) return;
    const stop = startPickupPipeline();
    if (isConnectingOrConnected(useChatConnectionStore.getState().connectionState)) warmUpPickupPipeline();
    return stop;
  }, [settingsHydrated, settingsKey, streamInfoKey]);

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
          <Label htmlFor="channel-input">Channel</Label>
          <div className="flex items-center gap-2">
            <Input
              id="channel-input"
              placeholder="e.g. zackrawrr"
              value={channelInput}
              onChange={(e) => setChannelInput(e.target.value)}
              disabled={connected}
            />
            {connected ? (
              <Button onClick={disconnect} variant="outline">
                Disconnect
              </Button>
            ) : (
              <Button onClick={handleConnect} disabled={channelInput.trim().length === 0}>
                Connect
              </Button>
            )}
            <SettingsDialog />
          </div>
          <p className="text-xs text-muted-foreground" role="status">
            Status: <span>{CONNECTION_STATE_LABEL[connectionState]}</span>
          </p>
        </div>
      </div>

      <ScrollArea className="h-[70vh]" viewportRef={scrollViewportRef}>
        <div
          className="grid grid-cols-3 gap-4"
          // 見出し1行 + 発言数ぶんの行。各列は subgrid でこの行トラックを共有する
          style={{ gridTemplateRows: `auto repeat(${messages.length}, auto)` }}
        >
          <Column
            title="Raw IRC"
            blurred={false}
            headerAction={
              <>
                <FollowToggle following={followLatest} onFollowingChange={setFollowLatest} />
                <LearningLanguagesDialog />
                <BotFilterDialog />
              </>
            }
          >
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <ChatMessageRow key={messageKey(message, index)} message={message} />
              ))}
            </div>
          </Column>
          <Column
            title="Translation"
            blurred={translationBlurred}
            headerAction={
              <>
                <ExplanationLanguageDialog />
                <BlurToggle label="Blur translation" blurred={translationBlurred} onBlurredChange={setTranslationBlurred} />
              </>
            }
            headerExtra={<PromptApiUnavailableReason promptApi={promptApi} />}
          >
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <Row key={messageKey(message, index)} message={message} blurred={translationBlurred}>
                  <PipelineCellContent
                    message={message}
                    entry={message.id === null ? undefined : translationEntries[message.id]}
                    promptApi={promptApi}
                    labels={TRANSLATION_LABELS}
                    renderDone={(done) => <TranslationText segments={done.segments} />}
                  />
                </Row>
              ))}
            </div>
          </Column>
          <Column
            title="Pick up"
            blurred={pickupBlurred}
            headerAction={<BlurToggle label="Blur Pick up" blurred={pickupBlurred} onBlurredChange={setPickupBlurred} />}
            headerExtra={<PromptApiUnavailableReason promptApi={promptApi} />}
          >
            <div role="list" className="contents">
              {messages.map((message, index) => (
                <Row key={messageKey(message, index)} message={message} blurred={pickupBlurred}>
                  <PipelineCellContent
                    message={message}
                    entry={message.id === null ? undefined : pickupEntries[message.id]}
                    promptApi={promptApi}
                    labels={PICKUP_LABELS}
                    renderDone={(done) => <PickupTerms terms={done.terms} />}
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
  /** スクリーンリーダー向けの名前(例: "Blur translation") */
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
 * 新着発言への追従を切り替えるアイコンのトグル。生IRC列の見出し右端に置く。
 * `role="switch"` + `aria-checked` で状態を公開し、オンの間はアイコンを強調色で表示する。
 */
function FollowToggle({
  following,
  onFollowingChange,
}: {
  following: boolean;
  onFollowingChange: (following: boolean) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      role="switch"
      aria-checked={following}
      aria-label="Follow new messages"
      className={cn(!following && "text-muted-foreground")}
      onClick={() => onFollowingChange(!following)}
    >
      <ChevronsDownIcon />
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
  /** 見出しの右端に置く操作(追従トグル・bot除外設定のアイコンなど) */
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
          <div className="flex items-center gap-1">{headerAction}</div>
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

/** Prompt API が利用できない環境で、列の見出し下に表示する理由。利用可能・診断中は何も表示しない */
function PromptApiUnavailableReason({ promptApi }: { promptApi: PromptApiStatus }) {
  if (promptApi.status !== "unavailable") return null;
  return <p className="text-xs font-normal text-destructive">{promptApi.reason}</p>;
}

/**
 * 翻訳列・Pick up列で共通の1行の中身。生成中・失敗・キュー溢れ・Prompt API 利用不可・
 * 言語判定によるスキップ(解説言語と同じ / 学ぶ言語ではない)の各状態を暗黙に隠さず明示する。表示文言は `labels`(翻訳列・Pick up 列ごとの文言一式)から選び、完了時の描画だけを
 * `renderDone` で列ごとに差し替える。
 */
function PipelineCellContent<TDone extends object>({
  message,
  entry,
  promptApi,
  labels,
  renderDone,
}: {
  message: TwitchChatMessage;
  entry: PipelineEntry<TDone> | undefined;
  promptApi: PromptApiStatus;
  /** 状態表示の文言一式(翻訳列なら `TRANSLATION_LABELS`) */
  labels: PipelineCellLabels;
  /** 完了した結果の描画 */
  renderDone: (done: TDone) => React.ReactNode;
}) {
  if (message.id === null) {
    return <span className="text-muted-foreground">{labels.notYet} (no message ID)</span>;
  }
  if (!entry) {
    if (promptApi.status === "unavailable") return <span className="text-muted-foreground">{labels.unavailable}</span>;
    if (promptApi.status === "checking") return <span className="text-muted-foreground">Preparing...</span>;
    return <span className="text-muted-foreground">{labels.notYet}</span>;
  }
  switch (entry.status) {
    case "pending":
      return <span className="text-muted-foreground">{labels.pending}</span>;
    case "done":
      return renderDone(entry);
    case "failed":
      return (
        <span className="text-destructive">
          {labels.failed}: {entry.reason}
        </span>
      );
    case "dropped":
      return <span className="text-muted-foreground">{labels.notYet} (too many messages)</span>;
    case "unavailable":
      return <span className="text-muted-foreground">{labels.unavailable}</span>;
    case "same-language":
      return <span className="text-muted-foreground">Same language</span>;
    case "other-language":
      return <span className="text-muted-foreground">Not a learning language ({entry.detectedLanguage})</span>;
  }
}

/** Pick up列の完了した結果。該当する表現が無い場合は「None」と控えめに表示する */
function PickupTerms({ terms }: { terms: PickupDone["terms"] }) {
  if (terms.length === 0) return <span className="text-muted-foreground">None</span>;
  return (
    <dl className="flex flex-col gap-0.5">
      {terms.map((term, index) => (
        <div key={index} className="flex flex-wrap gap-x-2">
          <dt className="font-semibold">{term.term}</dt>
          <dd className="text-muted-foreground">{term.meaning}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 翻訳文の中身。翻訳パイプライン(`translations.ts`)が emote をプレースホルダ経由で
 * 決定的に復元したセグメント列を保持しているため、左列と同じ描画関数でそのまま表示する(issue #28 → #44)
 */
function TranslationText({ segments }: TranslationDone) {
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
