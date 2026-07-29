/**
 * ホームページ(/) = ライブチャット画面。
 *
 * Twitch チャンネル名を入力して匿名接続し、流れてくる発言を
 * 表示名の色・emote画像付きでリアルタイム表示する。
 * サーバーへの送信は行わず、`irc-client.ts` が直接ブラウザから
 * `wss://irc-ws.chat.twitch.tv` へ接続する。
 *
 * 発言をクリックすると、設定済みの言語ペアで Prompt API(Gemini Nano)による
 * 構造化解説をダイアログ表示する(手動ピック)。Prompt API が利用できない
 * 環境では、理由を明示したうえで生成を行わない(暗黙のフォールバックはしない)。
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { createTwitchIrcClient, type ConnectionState, type TwitchIrcClient } from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { buildEmoteImageUrl, splitMessageIntoSegments } from "@/lib/twitch/emotes";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { describeDiagnosis } from "@/lib/ai/describeDiagnosis";
import type { EnvironmentDiagnosis } from "@/lib/ai/availability";
import { createExplainBaseSessionFactory, explainChatMessage } from "@/lib/ai/explain";
import { createSessionPool, type SessionPool } from "@/lib/ai/session-pool";
import { createAutoExtractionPipeline, type AutoExtractionPipeline } from "@/lib/ai/auto-extraction";
import type { ExplanationItem, ExplanationResult } from "@/lib/ai/schemas";
import { loadSettings } from "@/lib/settings";
import { createCard } from "@/lib/db/cards";

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

/** 発言クリックから開く解説ダイアログの状態 */
type ExplanationDialogState =
  | { status: "idle" }
  | { status: "unavailable"; sourceMessage: TwitchChatMessage; reason: string }
  | { status: "loading"; sourceMessage: TwitchChatMessage }
  | { status: "success"; sourceMessage: TwitchChatMessage; result: ExplanationResult }
  | { status: "error"; sourceMessage: TwitchChatMessage; errorMessage: string };

export default function Home() {
  const [channelInput, setChannelInput] = useState("");
  const [connectionState, setConnectionState] = useState<ConnectionState>("idle");
  const [messages, setMessages] = useState<TwitchChatMessage[]>([]);
  const clientRef = useRef<TwitchIrcClient | null>(null);

  // --- AI解説(手動ピック)・自動抽出(バックグラウンド)で共有する参照 ---
  const [aiDiagnosis, setAiDiagnosis] = useState<EnvironmentDiagnosis | null>(null);
  // getClient()のonEventはマウント時の1回しか再生成されないクロージャのため、
  // 最新のaiDiagnosisをrefにも同期しておき、自動抽出の実行可否をそこから判定する。
  const aiDiagnosisRef = useRef<EnvironmentDiagnosis | null>(null);
  const sessionPoolRef = useRef<SessionPool | null>(null);
  const autoExtractionPipelineRef = useRef<AutoExtractionPipeline | null>(null);
  const autoExtractionAbortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    aiDiagnosisRef.current = aiDiagnosis;
  }, [aiDiagnosis]);

  useEffect(() => {
    runBrowserDiagnosis()
      .then((diagnosis) => setAiDiagnosis(diagnosis))
      .catch(() => setAiDiagnosis(null));
  }, []);

  // セッションプールは設定(言語ペア)を使って初回利用時に一度だけ生成する。
  // 手動ピック(explain, high優先度)と自動抽出(triage/explain, low優先度)はこのプールを共有し、
  // Prompt APIの呼び出しを常に直列化する。
  const getSessionPool = useCallback((): SessionPool => {
    if (!sessionPoolRef.current) {
      const { settings } = loadSettings();
      sessionPoolRef.current = createSessionPool({
        createBaseSession: createExplainBaseSessionFactory(settings.targetLang, settings.explainLang),
      });
    }
    return sessionPoolRef.current;
  }, []);

  const getAutoExtractionPipeline = useCallback((): AutoExtractionPipeline => {
    if (!autoExtractionPipelineRef.current) {
      autoExtractionPipelineRef.current = createAutoExtractionPipeline({ sessionPool: getSessionPool() });
    }
    return autoExtractionPipelineRef.current;
  }, [getSessionPool]);

  // クライアントは初回レンダリング時に一度だけ生成する。
  // setState群はReactが安定した参照を保証するため、コールバック内で使っても古いクロージャの問題は起きない。
  // (refに保持したgetAutoExtractionPipeline/aiDiagnosisRefも、呼び出し時点で最新の値を参照する)
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

          const { settings } = loadSettings();
          if (settings.autoExtraction.enabled && aiDiagnosisRef.current?.overallReady) {
            getAutoExtractionPipeline()
              .processMessage(event.message, {
                strictness: settings.autoExtraction.strictness,
                targetLang: settings.targetLang,
                explainLang: settings.explainLang,
                signal: autoExtractionAbortControllerRef.current?.signal,
              })
              .catch(() => {
                // 自動抽出はベストエフォートのバックグラウンド処理のため、
                // 個別発言の失敗(Prompt APIエラー・中断)はUIに通知せず読み捨てる
              });
          }
        },
      });
    }
    return clientRef.current;
  }, [getAutoExtractionPipeline]);

  const handleConnect = useCallback(() => {
    const channel = channelInput.trim();
    if (!channel) return;
    setMessages([]);
    // チャンネルを切り替えるので、前のチャンネルに紐づく自動抽出ジョブを中断する
    autoExtractionAbortControllerRef.current?.abort();
    autoExtractionAbortControllerRef.current = new AbortController();
    getClient().connect(channel);
  }, [channelInput, getClient]);

  const handleDisconnect = useCallback(() => {
    autoExtractionAbortControllerRef.current?.abort();
    getClient().disconnect();
  }, [getClient]);

  const connected = isConnectingOrConnected(connectionState);

  // --- AI解説(手動ピック) ---
  const explainAbortControllerRef = useRef<AbortController | null>(null);
  const [dialogState, setDialogState] = useState<ExplanationDialogState>({ status: "idle" });

  const handleMessageClick = useCallback(
    (message: TwitchChatMessage) => {
      // 別の発言をクリックした場合、前のジョブは中断してから新しいジョブを開始する
      explainAbortControllerRef.current?.abort();
      const controller = new AbortController();
      explainAbortControllerRef.current = controller;

      if (!aiDiagnosis?.overallReady) {
        const reason = aiDiagnosis
          ? (describeDiagnosis(aiDiagnosis).find((m) => m.id === "language-model")?.message ??
            "Prompt API を利用できません。")
          : "環境診断が完了していません。少し待ってから再度お試しください。";
        setDialogState({ status: "unavailable", sourceMessage: message, reason });
        return;
      }

      setDialogState({ status: "loading", sourceMessage: message });
      explainChatMessage(getSessionPool(), message.text, { priority: "high", signal: controller.signal })
        .then((result) => {
          if (controller.signal.aborted) return;
          setDialogState({ status: "success", sourceMessage: message, result });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setDialogState({
            status: "error",
            sourceMessage: message,
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [aiDiagnosis, getSessionPool],
  );

  const handleDialogOpenChange = useCallback((open: boolean) => {
    if (!open) {
      explainAbortControllerRef.current?.abort();
      setDialogState({ status: "idle" });
    }
  }, []);

  // 解説内の語句をカード化(単語帳に保存)する。言語ペアはカード化時点の設定を保存する。
  const handleSaveCard = useCallback(async (item: ExplanationItem, sourceMessage: TwitchChatMessage) => {
    const { settings } = loadSettings();
    await createCard({
      term: item.term,
      kind: item.kind,
      meaning: item.meaning,
      note: item.note,
      sourceMessageText: sourceMessage.text,
      sourceChannel: sourceMessage.channel,
      sourceAuthor: sourceMessage.displayName,
      targetLang: settings.targetLang,
      explainLang: settings.explainLang,
      tags: [],
    });
  }, []);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>chat-sensei</CardTitle>
          <CardDescription>
            Twitch のチャンネル名を入力してライブチャットに接続します(ログイン不要)。発言をクリックするとAI解説が表示されます。
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
              <ChatMessageRow
                key={message.id ?? `${message.username}-${message.timestampMs}`}
                message={message}
                onSelect={handleMessageClick}
              />
            ))}
          </ol>
        </ScrollArea>
      </Card>

      <Dialog open={dialogState.status !== "idle"} onOpenChange={handleDialogOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>チャット解説</DialogTitle>
            {dialogState.status !== "idle" && (
              <DialogDescription>元の発言: {dialogState.sourceMessage.text}</DialogDescription>
            )}
          </DialogHeader>

          {dialogState.status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              解説を生成中...
            </div>
          )}

          {dialogState.status === "unavailable" && (
            <p className="text-sm text-muted-foreground">{dialogState.reason}</p>
          )}

          {dialogState.status === "error" && (
            <p className="text-sm text-destructive">{dialogState.errorMessage}</p>
          )}

          {dialogState.status === "success" && (
            <ExplanationResultView
              result={dialogState.result}
              sourceMessage={dialogState.sourceMessage}
              onSaveCard={handleSaveCard}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ExplanationResultView({
  result,
  sourceMessage,
  onSaveCard,
}: {
  result: ExplanationResult;
  sourceMessage: TwitchChatMessage;
  onSaveCard: (item: ExplanationItem, sourceMessage: TwitchChatMessage) => Promise<void>;
}) {
  // 項目インデックスごとのカード化状態。保存開始と同時に"pending"にしてボタンを無効化し、
  // 連打による重複保存を防ぐ(CodeRabbit指摘対応)。
  const [cardStatuses, setCardStatuses] = useState<Record<number, "pending" | "saved" | "error">>({});

  const handleSaveCardClick = useCallback(
    async (item: ExplanationItem, index: number) => {
      setCardStatuses((prev) => ({ ...prev, [index]: "pending" }));
      try {
        await onSaveCard(item, sourceMessage);
        setCardStatuses((prev) => ({ ...prev, [index]: "saved" }));
      } catch {
        setCardStatuses((prev) => ({ ...prev, [index]: "error" }));
      }
    },
    [onSaveCard, sourceMessage],
  );

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div>
        <p className="font-medium">訳</p>
        <p className="text-muted-foreground">{result.translation}</p>
      </div>
      <div>
        <p className="font-medium">直訳</p>
        <p className="text-muted-foreground">{result.literal}</p>
      </div>
      {result.items.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-medium">注目ポイント</p>
          {result.items.map((item, index) => {
            const status = cardStatuses[index];
            return (
              <div key={index} className="rounded-md border p-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{item.term}</span>
                    <Badge variant="secondary">{item.kind}</Badge>
                  </div>
                  <Button
                    onClick={() => handleSaveCardClick(item, index)}
                    disabled={status === "pending" || status === "saved"}
                    size="sm"
                    variant="outline"
                  >
                    {status === "saved" && "保存済み"}
                    {status === "pending" && "保存中..."}
                    {status === "error" && "再試行"}
                    {status === undefined && "カード化"}
                  </Button>
                </div>
                <p className="text-muted-foreground">{item.meaning}</p>
                <p className="text-xs text-muted-foreground">{item.note}</p>
                {status === "error" && <p className="text-xs text-destructive">カードの保存に失敗しました</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ChatMessageRow({
  message,
  onSelect,
}: {
  message: TwitchChatMessage;
  onSelect: (message: TwitchChatMessage) => void;
}) {
  const segments = useMemo(
    () => splitMessageIntoSegments(message.text, message.emotes),
    [message.text, message.emotes],
  );

  return (
    <li className="text-sm leading-relaxed break-words">
      <button
        type="button"
        onClick={() => onSelect(message)}
        className="w-full rounded px-1 text-left hover:bg-muted/50"
      >
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
      </button>
    </li>
  );
}
