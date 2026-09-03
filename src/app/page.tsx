/**
 * ホームページ(/)。接続状態で画面が切り替わる。
 *
 * - 未接続(idle / closed): ヘッダーなしのウェルカム画面を表示する。アプリ名とタグラインの下に
 *   チャンネル検索(ChannelSearchForm の hero バリアント)、言語ペアのセレクト、
 *   AIモデル設定(SettingsDialog のラベル付きトリガー)を縦に並べる
 * - 接続中(connecting / open / reconnecting): 上半分に配信embed(TwitchEmbedPlayer)と
 *   配信者情報パネル(StreamInfoPanel)、下半分に3カラムのチャット閲覧領域を表示する。
 *   全体がビューポート1ページに収まり(レイアウト側で高さを固定)、3カラム領域は
 *   発言数に関わらず最初から下半分の全域を占める(スクロールは3カラム領域の内部で行う)
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を3列で表示する。
 *
 * - 左列「Raw Chat」: 受信した発言をそのまま(表示名の色・emote画像付きで)表示する
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
 * Raw Chat列の見出しには、新着発言に合わせてスクロール領域を最下部へ送り続ける追従トグル(FollowToggle。
 * 初期状態はオンで、利用者が上へスクロールして最下部から離れると自動でオフになる)と、
 * bot除外設定(BotFilterDialog)を開くアイコンを置く。
 * 言語ペア(学ぶ言語 / 解説言語)のセレクトと設定ダイアログは、未接続時はこのページの
 * ウェルカム画面に、接続中はヘッダー(SiteHeader)に表示する。除外パターンは
 * bot-filter ストアが LocalStorage から復元し、chat-connection ストアが受信時に適用する。
 * 接続状態・受信済み発言はモジュールスコープのストア(chat-connection.ts)が、
 * 翻訳結果は translations ストアが、抽出結果は pickups ストアが保持し、
 * 各パイプラインはこの画面のマウント時に開始する。Raw Chat列のテキストを範囲選択すると
 * フローティングの「Pick up」ボタン(ManualPickupOverlay)が出て、選択した語句を手動でPick upできる
 * (issue #72。意味の生成状態は manual-pickups ストアが保持し、Pick up列で自動抽出分とあわせて表示する)。
 * Pick up列の各語句はユーザーが削除でき、
 * 削除した語句は hidden-pickups ストアが保持して表示時に除外する(issue #71)。Prompt API の利用可否は両列で共通の
 * prompt-api ストアを参照し、利用不可の理由は翻訳列・Pick up列それぞれの見出し下に表示する。
 * 言語設定は settings ストアが LocalStorage から復元し、パイプラインは復元後に開始する。言語設定が変わると
 * 両パイプラインを停止して新しい設定で開始し直す(生成済みの翻訳・Pick up は破棄され、表示中の発言は再生成される。
 * ただし削除した語句の非表示集合は破棄されないため、再生成後も削除は維持される)。
 * 解説言語と同じ言語の発言は逆方向(学ぶ言語への翻訳 + その訳文からの Pick up)で処理されるため、
 * 発言ごとの言語判定で処理しなかった行(学ぶ言語でも解説言語でもない)だけ、その旨を各列に表示する。
 */
"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronsDownIcon, EyeIcon, EyeOffIcon, XIcon } from "lucide-react";
import { BotFilterDialog } from "@/components/bot-filter-dialog";
import { ManualPickupOverlay, MESSAGE_TEXT_ATTRIBUTE, RAW_IRC_COLUMN_NAME } from "@/components/manual-pickup";
import { ChannelSearchForm } from "@/components/channel-search-form";
import { LanguagePairSelect } from "@/components/language-pair-select";
import { SettingsDialog } from "@/components/settings-dialog";
import { StreamInfoPanel } from "@/components/stream-info-panel";
import { TwitchEmbedPlayer } from "@/components/twitch-embed-player";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments, type MessageSegment } from "@/lib/twitch/emotes";
import { useAvatarStore } from "@/store/avatars";
import { useBadgeStore } from "@/store/badges";
import { hydrateBotFilterStore } from "@/store/bot-filter";
import { isConnectingOrConnected, useChatConnectionStore } from "@/store/chat-connection";
import type { PipelineEntry } from "@/store/auto-pipeline";
import { hidePickupTerm, isPickupTermHidden, useHiddenPickupStore } from "@/store/hidden-pickups";
import { announcePickupRemoval, usePickupAnnouncementStore } from "@/store/pickup-announcements";
import { addManualPickup, removeManualPickup, useManualPickupStore } from "@/store/manual-pickups";
import { startPickupPipeline, usePickupStore, warmUpPickupPipeline, type PickupDone } from "@/store/pickups";
import { usePromptApiStore, type PromptApiStatus } from "@/store/prompt-api";
import { hydrateSettingsStore, useSettingsStore } from "@/store/settings";
import { useStreamInfoStore } from "@/store/stream-info";
import { streamInfoPromptKey } from "@/lib/twitch/stream-info";
import {
  startTranslationPipeline,
  useTranslationStore,
  warmUpTranslationPipeline,
  type TranslationDone,
} from "@/store/translations";

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

export default function Home() {
  const connectionState = useChatConnectionStore((state) => state.connectionState);
  const messages = useChatConnectionStore((state) => state.messages);
  const channel = useChatConnectionStore((state) => state.channel);

  // 翻訳列・Pick up列のぼかし。初期状態はどちらも見える(自力で読みたいときに利用者がぼかす)
  const [translationBlurred, setTranslationBlurred] = useState(false);
  const [pickupBlurred, setPickupBlurred] = useState(false);

  // 新着発言への追従。オンの間は発言が増えるたびにスクロール領域を最下部へ送る。
  // アバター(issue #60)は発言の表示後に遅れて届いて行の高さを増やすため、
  // その反映時にも最下部へ送り直す(でないと最新の発言が見切れたまま追従が止まる)
  const [followLatest, setFollowLatest] = useState(true);
  const avatars = useAvatarStore((state) => state.avatars);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!followLatest) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.scrollTop = viewport.scrollHeight;
  }, [followLatest, messages, avatars]);
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
    settings.learningLang,
    settings.explainLang,
    settings.llmProvider,
    settings.openRouterApiKey,
    settings.openRouterModel,
  ].join("|");

  // 配信の文脈(タイトル・カテゴリ。issue #54)はセッションプールのシステムプロンプトに焼き込むため、
  // 読み込み完了・チャンネル切り替えで内容が変わったときもパイプラインを再起動して反映する
  // (言語設定の変更と同じ機構。生成済みの翻訳・Pick up は破棄され、表示中の発言は再生成される)
  const streamInfo = useStreamInfoStore((state) => state.streamInfo);
  // viewerCount など、プロンプトに焼き込まないフィールドの定期リフレッシュ(issue #85)では再起動しない
  const streamInfoKey = streamInfoPromptKey(streamInfo);

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

  const connected = isConnectingOrConnected(connectionState);

  // Raw Chat列の範囲選択から手動Pick up(issue #72)。選択した語句の意味を、発言本文を文脈として生成する
  const handleManualPickup = useCallback((messageId: string, term: string) => {
    const message = useChatConnectionStore.getState().messages.find((item) => item.id === messageId);
    // 選択からクリックまでの間に発言がリングバッファから溢れた場合、結果を表示する行が無いため追加しない
    if (!message) return;
    void addManualPickup(messageId, term, message.text);
  }, []);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4">
      {!connected ? (
        // 未接続: ヘッダーなしのウェルカム画面。アプリ名 + タグラインの下にチャンネル検索を置き、
        // 言語ペア・AIモデルの設定もこの画面から触れるようにする(接続中はヘッダーに移る)
        <div className="flex flex-1 items-center justify-center">
          <div className="flex w-full max-w-md flex-col items-center gap-10">
            <div className="flex flex-col items-center gap-3 text-center">
              <h1 className="font-heading text-4xl font-semibold tracking-tight">chat-sensei</h1>
              <p className="text-sm text-muted-foreground">
                Learn a language from live Twitch chat — translated and explained as it flows.
              </p>
            </div>
            <ChannelSearchForm variant="hero" />
            <div className="flex flex-col items-center gap-3">
              <LanguagePairSelect />
              <SettingsDialog triggerLabel="AI model settings" />
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* 上半分: 配信embed + 配信者情報パネル */}
          <div className="flex min-h-0 flex-1 gap-4">
            {channel !== null && (
              // iframe(TwitchEmbedPlayer)は幅基準(aspect-video w-full)のため、
              // 高さ基準のラッパーで「上半分の高さいっぱいの16:9」に切り出す
              <div className="aspect-video h-full min-w-0">
                <TwitchEmbedPlayer channel={channel} />
              </div>
            )}
            <StreamInfoPanel />
          </div>

          {/* 下半分: 3カラムのチャット閲覧領域(発言数に関わらず最初から全域を占め、内部でスクロールする) */}
          <ScrollArea className="min-h-0 flex-1" viewportRef={scrollViewportRef}>
            <div
              className="grid min-h-full grid-cols-3 gap-4"
              // 見出し1行 + 発言数ぶんの行 + 余白吸収の1fr行(発言が少なくても列が下半分の全域に伸びる)。
              // 各列は subgrid でこの行トラックを共有する
              style={{ gridTemplateRows: `auto repeat(${messages.length}, auto) 1fr` }}
            >
          <Column
            title="Raw Chat"
            blurred={false}
            dataColumn={RAW_IRC_COLUMN_NAME}
            headerAction={
              <>
                <FollowToggle following={followLatest} onFollowingChange={setFollowLatest} />
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
              <BlurToggle label="Blur translation" blurred={translationBlurred} onBlurredChange={setTranslationBlurred} />
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
                    renderDone={(done, messageId) => <PickupTerms messageId={messageId} terms={done.terms} />}
                  />
                  {/* 手動Pick up(issue #72)は自動抽出の状態(生成中・失敗など)に関わらず表示する */}
                  {message.id !== null && <ManualPickupTerms messageId={message.id} />}
                </Row>
              ))}
            </div>
          </Column>
            </div>
          </ScrollArea>
        </>
      )}
      <ManualPickupOverlay onPickup={handleManualPickup} />
      <PickupRemovalAnnouncement />
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
 * 新着発言への追従を切り替えるアイコンのトグル。Raw Chat列の見出し右端に置く。
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
  dataColumn,
  headerExtra,
  headerAction,
  children,
}: {
  title: string;
  /** 列全体がぼかし中か(実際のぼかしは行単位で適用し、ここでは data 属性で状態を公開する) */
  blurred: boolean;
  /** 列の識別子(`data-column` 属性)。手動Pick upの選択範囲の判定(Raw Chat列に限定)に使う */
  dataColumn?: string;
  /** 見出しの下に表示する補足(Prompt API 利用不可の理由など) */
  headerExtra?: React.ReactNode;
  /** 見出しの右端に置く操作(追従トグル・bot除外設定のアイコンなど) */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-column={dataColumn}
      data-blurred={blurred}
      className="grid min-w-0 grid-rows-subgrid row-[1/-1] rounded-xl border bg-card pb-3"
    >
      <div className="sticky top-0 z-10 border-b bg-card px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          {/* 列見出しは小さめ + わずかな letter-spacing で引き締める(issue #87) */}
          <h2 className="font-heading text-xs font-semibold tracking-wide">{title}</h2>
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
      // Pick up列で行内の削除ボタンをすべて消したとき、フォーカスの退避先になる(issue #73)。
      // tabIndex={-1} は Tab 順序には入れず、プログラムからのフォーカスだけを受け付ける
      tabIndex={-1}
      // ぼかしは「自力で読む練習」のために中身を隠す機能なので、視覚だけでなくフォーカス・
      // 読み上げの対象からも外す(Pick up列の削除ボタンが不可視のまま操作できたり、
      // スクリーンリーダーで語句が漏れたりしないように)
      inert={blurred || undefined}
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
 * 言語判定によるスキップ(学ぶ言語でも解説言語でもない)の各状態を暗黙に隠さず明示する。表示文言は `labels`(翻訳列・Pick up 列ごとの文言一式)から選び、完了時の描画だけを
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
  /** 完了した結果の描画。messageId は null を除外済み(ID の無い発言はエントリ自体が作られない) */
  renderDone: (done: TDone, messageId: string) => React.ReactNode;
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
      return renderDone(entry, message.id);
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
    case "other-language":
      return <span className="text-muted-foreground">Not a learning language ({entry.detectedLanguage})</span>;
  }
}

/**
 * Pick up列の完了した結果。該当する表現が無い場合は何も表示しない(「None」が並ぶと見栄えが悪いため)。
 *
 * ユーザーが削除した語句(hidden-pickups ストア。issue #71)は表示から除外する。
 * 削除ボタンは語句の hover 時(またはフォーカス時)に表示する × アイコンで、押すと
 * その発言のその語句を非表示集合へ追加する。hover が無いタッチ端末では常に表示する
 * (不可視のままクリック可能領域だけが残り、誤タップで気付かず削除されるのを防ぐ)。
 * 非表示集合はパイプライン再起動で破棄されないため、エントリの再生成後も削除が維持される。
 *
 * 発言のたびに全行が再レンダーされるため memo 化する(props の messageId・terms は
 * エントリが変わらない限り同一参照で、非表示集合の変化はストア購読で拾う)。
 */
const PickupTerms = memo(function PickupTerms({
  messageId,
  terms,
}: {
  messageId: string;
  terms: PickupDone["terms"];
}) {
  const hiddenTerms = useHiddenPickupStore((state) => state.hiddenTerms[messageId]);
  const visibleTerms =
    hiddenTerms === undefined ? terms : terms.filter((term) => !isPickupTermHidden(hiddenTerms, term.term));
  if (visibleTerms.length === 0) {
    return null;
  }
  return (
    <dl className="flex flex-col gap-0.5">
      {visibleTerms.map((term) => (
        <PickupTermRow key={term.term} term={term.term} onRemove={() => hidePickupTerm(messageId, term.term)}>
          <dd className="text-muted-foreground">{term.meaning}</dd>
        </PickupTermRow>
      ))}
    </dl>
  );
});

/**
 * Pick up列の語句1件の行(語句 + hover時の削除ボタン + 意味などの内容)。
 * 自動抽出分(PickupTerms)と手動Pick up分(ManualPickupTerms)で見た目・削除ボタンの挙動を揃えるための共通部品。
 * 削除ボタンは hover 時(またはフォーカス時)に表示し、hover が無いタッチ端末では常に表示する(issue #71 と同じ)。
 * `children` には意味(dd)や生成状態の表示を渡す。
 */
function PickupTermRow({
  term,
  onRemove,
  children,
}: {
  term: string;
  /** 削除ボタンが押されたときの処理(自動分は非表示集合へ追加、手動分はストアから削除) */
  onRemove: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="group/term flex flex-wrap items-baseline gap-x-2">
      {/* 「チャットから拾い上げた語彙」が目に留まるよう、語句をゴールド + 破線下線で強調する(issue #87)。
          破線下線は inline-flex の削除ボタンには波及しない */}
      <dt className="font-semibold text-pickup underline decoration-dashed decoration-pickup/50 underline-offset-4">
        {term}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove "${term}"`}
          data-pickup-remove
          className="ml-1 align-middle opacity-0 group-hover/term:opacity-100 focus:opacity-100 pointer-coarse:opacity-100"
          onClick={(event) => handleRemoveClick(event, term, onRemove)}
        >
          <XIcon />
        </Button>
      </dt>
      {children}
    </div>
  );
}

/**
 * Pick up列の削除ボタンが押されたときの共通処理(issue #73)。
 * 押されたボタン自身は unmount されてフォーカスが body に落ちるため、削除前に同じ発言の行
 * (`role="listitem"`)内の削除ボタン一覧から次(無ければ前)のボタンを探し、削除後にそこへ
 * フォーカスを移す。どちらも無ければ行コンテナ(tabIndex={-1})へ退避し、Tab 移動が
 * ページ先頭からやり直しになるのを防ぐ。あわせてスクリーンリーダーへ削除を通知する。
 * 移動先のボタン・行コンテナの DOM ノードは削除後も同一のまま残るため、削除前に取得した
 * 参照へそのままフォーカスしてよい。
 */
function handleRemoveClick(event: React.MouseEvent<HTMLButtonElement>, term: string, onRemove: () => void): void {
  const row = event.currentTarget.closest<HTMLElement>('[role="listitem"]');
  const buttons = row === null ? [] : Array.from(row.querySelectorAll<HTMLElement>("[data-pickup-remove]"));
  const index = buttons.indexOf(event.currentTarget);
  const focusTarget = buttons[index + 1] ?? buttons[index - 1] ?? row;
  onRemove();
  announcePickupRemoval(term);
  focusTarget?.focus();
}

/**
 * Pick up語句の削除をスクリーンリーダーへ通知する常設の aria-live リージョン(issue #73)。
 * `role="status"`(polite)の視覚非表示要素として置き、pickup-announcements ストアの
 * メッセージを表示する。同じ語句を連続で削除してもテキストの変化として検知されるよう、
 * 通知番号(seq)の偶奇で不可視のノーブレークスペースを付け替える。
 */
function PickupRemovalAnnouncement() {
  const { message, seq } = usePickupAnnouncementStore();
  return (
    // 接続状態の role="status" と区別できるよう、リージョンに名前を付ける
    <div role="status" aria-label="Pick up updates" className="sr-only">
      {message}
      {seq % 2 === 1 ? "\u00A0" : ""}
    </div>
  );
}

/**
 * 手動Pick up(範囲選択で追加した語句。issue #72)の一覧。manual-pickups ストアを購読し、
 * 自動抽出分(PickupTerms)とは独立に、Pick up列の同じ行の中で自動分の下に表示する。
 * 生成中(Looking up...)・失敗(理由付き)の状態も暗黙に隠さず明示する
 * (自動抽出の PipelineCellContent と同じ考え方)。削除ボタンは自動分と同じ見た目・挙動で、
 * こちらは非表示集合ではなく手動Pick upのストアから直接削除する(再生成が無いため復活の懸念が無い)。
 */
const ManualPickupTerms = memo(function ManualPickupTerms({ messageId }: { messageId: string }) {
  const entries = useManualPickupStore((state) => state.entries[messageId]);
  if (entries === undefined || entries.length === 0) return null;
  return (
    <dl className="flex flex-col gap-0.5">
      {entries.map((entry) => (
        <PickupTermRow key={entry.term} term={entry.term} onRemove={() => removeManualPickup(messageId, entry.term)}>
          {entry.status === "pending" && <dd className="text-muted-foreground">Looking up...</dd>}
          {entry.status === "done" && <dd className="text-muted-foreground">{entry.meaning}</dd>}
          {entry.status === "failed" && <dd className="text-destructive">Lookup failed: {entry.reason}</dd>}
        </PickupTermRow>
      ))}
    </dl>
  );
});

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
  // 発言者のアバター(issue #60)。未取得・取得失敗(Helix 利用不可を含む)は undefined で、アバターなしの表示になる
  const avatarUrl = useAvatarStore((state) =>
    message.userId === null ? undefined : state.avatars[message.userId],
  );
  // バッジ対応表(issue #61)。未読み込み・Helix 利用不可時は空で、バッジ非表示の現行表示になる
  const badgeImages = useBadgeStore((state) => state.badgeImages);

  return (
    <Row message={message} blurred={false}>
      {avatarUrl !== undefined && (
        // eslint-disable-next-line @next/next/no-img-element -- Twitch CDNの外部画像のためnext/imageのドメイン許可設定は不要な単純imgで表示する
        <img
          src={avatarUrl}
          // 直後に表示名がテキストで続くため、アバターは装飾画像として扱う
          alt=""
          className="mr-1 inline-block size-5 rounded-full align-text-bottom"
        />
      )}
      {message.badges.map((badge) => {
        const badgeImageUrl = badgeImages[`${badge.name}/${badge.version}`];
        // 対応表に無いバッジ(未知の set_id など)は非表示のまま現行どおり動作する
        if (badgeImageUrl === undefined) return null;
        return (
          // eslint-disable-next-line @next/next/no-img-element -- Twitch CDNの外部画像のためnext/imageのドメイン許可設定は不要な単純imgで表示する
          <img
            key={`${badge.name}/${badge.version}`}
            src={badgeImageUrl}
            alt={badge.name}
            title={badge.name}
            className="mr-1 inline-block h-[18px] w-[18px] align-text-bottom"
          />
        );
      })}
      <span className="font-semibold" style={message.color ? { color: message.color } : undefined}>
        {message.displayName}
      </span>
      <span>: </span>
      {/* 手動Pick up(issue #72)の選択判定を本文に限定するための目印。表示名まで含む選択をPick upさせない */}
      <span {...{ [MESSAGE_TEXT_ATTRIBUTE]: "" }}>
        <MessageSegments segments={segments} />
      </span>
    </Row>
  );
}
