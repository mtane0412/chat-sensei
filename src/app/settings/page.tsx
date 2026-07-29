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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { describeDiagnosis, type DiagnosisMessage } from "@/lib/ai/describeDiagnosis";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/lib/ai/prompts";
import { AUTO_EXTRACTION_STRICTNESS_LEVELS, type AutoExtractionStrictness } from "@/lib/twitch/message-filter";
import {
  AUTO_EXTRACTION_STRICTNESS_DISPLAY_NAMES,
  DEFAULT_SETTINGS,
  LANGUAGE_DISPLAY_NAMES,
  loadSettings,
  saveSettings,
  settingsSchema,
  type Settings,
} from "@/lib/settings";

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

  const [settingsForm, setSettingsForm] = useState<Settings>(DEFAULT_SETTINGS);
  const [wasCorrupted, setWasCorrupted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  // LocalStorage(外部システム)から読み込んだ値を React state に同期する。
  // SSR時は window が無いため呼べない(hydrationミスマッチを避けるため useEffect でのみ実行する)。
  // setState をマイクロタスク内に閉じ込め、useEffect本体からの同期的な呼び出しを避ける
  // (診断処理(fetchDiagnosis)と同じ理由・同じパターン)。
  useEffect(() => {
    Promise.resolve().then(() => {
      const result = loadSettings();
      setSettingsForm(result.settings);
      setWasCorrupted(result.wasCorrupted);
    });
  }, []);

  const handleSaveSettings = useCallback(() => {
    setSavedNotice(false);
    const validation = settingsSchema.safeParse(settingsForm);
    if (!validation.success) {
      setSaveError(validation.error.issues[0]?.message ?? "設定が不正です");
      return;
    }
    saveSettings(validation.data);
    setSaveError(null);
    setSavedNotice(true);
  }, [settingsForm]);

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

      <Card>
        <CardHeader>
          <CardTitle>言語設定</CardTitle>
          <CardDescription>
            Twitchチャットの原文言語(学ぶ言語)と、AIが解説を生成する言語(解説言語)を選びます。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {wasCorrupted && (
            <Alert className="border-amber-500/50 text-amber-700 dark:text-amber-400">
              <AlertTriangle aria-hidden="true" />
              <AlertDescription>
                保存されていた設定を読み込めなかったため、デフォルト設定に戻しました。
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="target-lang-select">学ぶ言語</Label>
            <select
              id="target-lang-select"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
              value={settingsForm.targetLang}
              onChange={(e) =>
                setSettingsForm((prev) => ({ ...prev, targetLang: e.target.value as SupportedLanguage }))
              }
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGE_DISPLAY_NAMES[lang]}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="explain-lang-select">解説言語</Label>
            <select
              id="explain-lang-select"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
              value={settingsForm.explainLang}
              onChange={(e) =>
                setSettingsForm((prev) => ({ ...prev, explainLang: e.target.value as SupportedLanguage }))
              }
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {LANGUAGE_DISPLAY_NAMES[lang]}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>自動抽出</CardTitle>
          <CardDescription>
            チャットを眺めているだけで、学習価値の高い発言をAIが自動で見つけ、単語帳の候補として貯めます。
            候補は /deck でレビューして採用/却下してください(判定にもGemini
            Nanoを使うため、手動ピックより低い優先度で処理されます)。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="auto-extraction-enabled-switch">自動抽出を有効にする</Label>
            <Switch
              id="auto-extraction-enabled-switch"
              checked={settingsForm.autoExtraction.enabled}
              onCheckedChange={(enabled) =>
                setSettingsForm((prev) => ({ ...prev, autoExtraction: { ...prev.autoExtraction, enabled } }))
              }
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="auto-extraction-strictness-select">フィルタの厳しさ</Label>
            <select
              id="auto-extraction-strictness-select"
              className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
              value={settingsForm.autoExtraction.strictness}
              disabled={!settingsForm.autoExtraction.enabled}
              onChange={(e) =>
                setSettingsForm((prev) => ({
                  ...prev,
                  autoExtraction: {
                    ...prev.autoExtraction,
                    strictness: e.target.value as AutoExtractionStrictness,
                  },
                }))
              }
            >
              {AUTO_EXTRACTION_STRICTNESS_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {AUTO_EXTRACTION_STRICTNESS_DISPLAY_NAMES[level]}
                </option>
              ))}
            </select>
          </div>

          {saveError && (
            <Alert variant="destructive">
              <XCircle aria-hidden="true" />
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}

          {savedNotice && !saveError && (
            <Alert className="border-emerald-500/50 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 aria-hidden="true" />
              <AlertDescription>設定を保存しました</AlertDescription>
            </Alert>
          )}

          <Button onClick={handleSaveSettings} className="self-start">
            保存する
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
