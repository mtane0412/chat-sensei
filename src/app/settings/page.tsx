/**
 * 設定画面(/settings)。
 *
 * chat-sensei はサーバーを持たないクライアントサイド専用アプリであり、
 * AI解説・自動抽出はすべて Chrome 内蔵の Prompt API(Gemini Nano)に依存する。
 * ここでは起動時にブラウザ環境を診断し、Prompt API / Language Detector API が
 * 利用できるかどうかと、利用できない場合の理由を利用者に明示する。
 *
 * 学習言語・解説言語の設定(LocalStorage連携)は Phase 2 以降で追加する。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { describeDiagnosis, type DiagnosisMessage } from "@/lib/ai/describeDiagnosis";

type DiagnosisState =
  | { status: "loading" }
  | { status: "loaded"; messages: DiagnosisMessage[] }
  | { status: "error"; errorMessage: string };

/** 重大度ごとのアイコンと Alert の見た目を決める(shadcn/ui の Alert は default/destructive の2種のみのため、warning/ok は className で調整する) */
function messageStyle(level: DiagnosisMessage["level"]) {
  switch (level) {
    case "ok":
      return {
        variant: "default" as const,
        className: "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
        Icon: CheckCircle2,
      };
    case "warning":
      return {
        variant: "default" as const,
        className: "border-amber-500/50 text-amber-700 dark:text-amber-400",
        Icon: AlertTriangle,
      };
    case "error":
      return { variant: "destructive" as const, className: "", Icon: XCircle };
  }
}

export default function SettingsPage() {
  const [state, setState] = useState<DiagnosisState>({ status: "loading" });

  // 診断の実行そのものは副作用(setState)を .then/.catch 内に閉じ込め、
  // useEffect の本体からは直接呼び出すだけにする(同期的な setState 呼び出しを避けるため)。
  const fetchDiagnosis = useCallback(() => {
    runBrowserDiagnosis()
      .then((diagnosis) => {
        setState({ status: "loaded", messages: describeDiagnosis(diagnosis) });
      })
      .catch((error: unknown) => {
        setState({
          status: "error",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  useEffect(() => {
    fetchDiagnosis();
  }, [fetchDiagnosis]);

  // 「再診断する」ボタン用ハンドラ。ユーザー操作(イベントハンドラ)内での setState のため問題ない。
  const handleRetry = useCallback(() => {
    setState({ status: "loading" });
    fetchDiagnosis();
  }, [fetchDiagnosis]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6">
      <Card>
        <CardHeader>
          <CardTitle>環境診断</CardTitle>
          <CardDescription>
            chat-sensei は Chrome 内蔵の Prompt API(Gemini Nano)のみで動作します。サーバーへの送信は行いません。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {state.status === "loading" && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              診断中...
            </div>
          )}

          {state.status === "error" && (
            <Alert variant="destructive">
              <XCircle aria-hidden="true" />
              <AlertTitle>診断中にエラーが発生しました</AlertTitle>
              <AlertDescription>{state.errorMessage}</AlertDescription>
            </Alert>
          )}

          {state.status === "loaded" &&
            state.messages.map((message) => {
              const { variant, className, Icon } = messageStyle(message.level);
              return (
                <Alert key={message.id} variant={variant} className={className}>
                  <Icon aria-hidden="true" />
                  <AlertDescription>{message.message}</AlertDescription>
                </Alert>
              );
            })}

          <Button onClick={handleRetry} variant="outline" className="self-start">
            再診断する
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
