/**
 * 設定ダイアログ(issue #17)。
 *
 * ホーム画面の接続フォーム横に置いた歯車アイコンから開き、3カラム画面から離れずに次のことができる。
 *
 * - 言語ペア(学ぶ言語 = Twitch チャットの原文言語 / 解説言語 = 訳文・Pick up の意味の言語)を en / ja / es / de / fr から選んで保存する。
 *   同じ言語の組み合わせは `settingsSchema` が拒否するため、エラーを表示して保存しない
 * - 復元時に保存データが壊れていた場合(`wasCorrupted`)は、デフォルトに戻した旨を伝える
 * - 開くたびに環境診断(`runBrowserDiagnosis` → `describeDiagnosis`)を実行し、Prompt API が使えない環境ではその理由を表示する
 *   (chat-sensei は暗黙にクラウド API へ切り替えないため、理由を利用者にそのまま伝える)
 * - 保存されている設定を LocalStorage から削除してデフォルトに戻す
 *
 * 保存は `useSettingsStore.setSettings` が LocalStorage へ永続化し、ホーム画面が言語ペアの変更を購読して
 * 翻訳・Pick up のパイプラインを新しい言語ペアで再起動する。
 */
"use client";

import { useEffect, useState } from "react";
import { z } from "zod";
import { AlertTriangleIcon, CheckCircle2Icon, SettingsIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { describeDiagnosis, type DiagnosisMessage } from "@/lib/ai/describeDiagnosis";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/lib/ai/prompts";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { LANGUAGE_DISPLAY_NAMES, settingsSchema, type Settings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { clearSettingsStore, useSettingsStore } from "@/store/settings";

const DIALOG_TITLE = "設定";
/** セレクトの値(文字列)を対応言語コードに検証する。対応外の値は Fail-Fast で例外にする */
const languageSchema = z.enum(SUPPORTED_LANGUAGES);
const TARGET_LANG_SELECT_ID = "settings-target-lang";
const EXPLAIN_LANG_SELECT_ID = "settings-explain-lang";

type DiagnosisState =
  | { status: "loading" }
  | { status: "loaded"; messages: DiagnosisMessage[] }
  | { status: "error"; errorMessage: string };

/** 診断メッセージの重大度ごとのアイコンと文字色 */
const DIAGNOSIS_LEVEL_STYLE: Record<DiagnosisMessage["level"], { Icon: typeof CheckCircle2Icon; className: string }> = {
  ok: { Icon: CheckCircle2Icon, className: "text-emerald-700 dark:text-emerald-400" },
  warning: { Icon: AlertTriangleIcon, className: "text-amber-700 dark:text-amber-400" },
  error: { Icon: XCircleIcon, className: "text-destructive" },
};

export function SettingsDialog() {
  const settings = useSettingsStore((state) => state.settings);
  const wasCorrupted = useSettingsStore((state) => state.wasCorrupted);
  const setSettings = useSettingsStore((state) => state.setSettings);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Settings>(settings);
  const [saveError, setSaveError] = useState<string | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    // 開くたびにストアの現在値から下書きを作り直す(前回の未保存の編集・エラーを持ち越さない)
    if (nextOpen) {
      setDraft(settings);
      setSaveError(null);
    }
    setOpen(nextOpen);
  };

  const handleSave = () => {
    const validation = settingsSchema.safeParse(draft);
    if (!validation.success) {
      setSaveError(validation.error.issues[0]?.message ?? "設定が不正です");
      return;
    }
    setSettings(validation.data);
    setOpen(false);
  };

  const handleClear = () => {
    clearSettingsStore();
    setDraft(useSettingsStore.getState().settings);
    setSaveError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={DIALOG_TITLE} />}>
        <SettingsIcon />
      </DialogTrigger>
      <DialogContent aria-label={DIALOG_TITLE}>
        <DialogHeader>
          <DialogTitle>{DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            学ぶ言語(チャットの原文の言語)と解説言語(翻訳・Pick up の意味を表示する言語)を選びます。
            保存すると表示中の発言の翻訳・Pick up を新しい言語ペアで生成し直します。
          </DialogDescription>
        </DialogHeader>

        {wasCorrupted && (
          <p className="text-xs text-destructive" role="alert">
            保存されていた設定が壊れていたため、デフォルトに戻しました。保存し直すと解消します。
          </p>
        )}

        <div className="grid grid-cols-2 gap-4">
          <LanguageSelect
            id={TARGET_LANG_SELECT_ID}
            label="学ぶ言語"
            value={draft.targetLang}
            onChange={(targetLang) => setDraft((prev) => ({ ...prev, targetLang }))}
          />
          <LanguageSelect
            id={EXPLAIN_LANG_SELECT_ID}
            label="解説言語"
            value={draft.explainLang}
            onChange={(explainLang) => setDraft((prev) => ({ ...prev, explainLang }))}
          />
        </div>

        {saveError && (
          <p className="text-xs text-destructive" role="alert">
            {saveError}
          </p>
        )}

        <DiagnosisSection open={open} />

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={handleClear}>
            設定を初期化する
          </Button>
          <div className="flex gap-2">
            <DialogClose render={<Button variant="outline" />}>キャンセル</DialogClose>
            <Button onClick={handleSave}>保存する</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 言語を1つ選ぶセレクト。選択肢は Prompt API が対応する5言語で固定 */
function LanguageSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: SupportedLanguage;
  onChange: (value: SupportedLanguage) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select
        id={id}
        className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm dark:bg-input/30"
        value={value}
        onChange={(e) => onChange(languageSchema.parse(e.target.value))}
      >
        {SUPPORTED_LANGUAGES.map((lang) => (
          <option key={lang} value={lang}>
            {LANGUAGE_DISPLAY_NAMES[lang]}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * 環境診断の結果。ダイアログを開くたびに診断し直す(モデルのダウンロード完了などで結果が変わり得るため)。
 * 診断中・失敗・結果一覧の各状態を暗黙に隠さず表示する。
 */
function DiagnosisSection({ open }: { open: boolean }) {
  const [state, setState] = useState<DiagnosisState>({ status: "loading" });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 診断の副作用(setState)は Promise の中に閉じ込め、閉じた後に届いた結果は捨てる
    runBrowserDiagnosis()
      .then((diagnosis) => {
        if (!cancelled) setState({ status: "loaded", messages: describeDiagnosis(diagnosis) });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errorMessage: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
      setState({ status: "loading" });
    };
  }, [open]);

  return (
    <section aria-label="環境診断" className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">環境診断</h3>
      {state.status === "loading" && <p className="text-xs text-muted-foreground">診断中...</p>}
      {state.status === "error" && (
        <p className="text-xs text-destructive" role="alert">
          環境診断に失敗しました: {state.errorMessage}
        </p>
      )}
      {state.status === "loaded" && (
        <ul className="flex flex-col gap-1.5">
          {state.messages.map((message) => {
            const { Icon, className } = DIAGNOSIS_LEVEL_STYLE[message.level];
            return (
              <li key={message.id} className={cn("flex items-start gap-1.5 text-xs", className)}>
                <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                <span>{message.message}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
