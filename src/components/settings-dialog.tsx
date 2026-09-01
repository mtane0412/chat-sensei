/**
 * 設定ダイアログ(issue #17)。アプリ全体に関わる項目だけを扱う。
 *
 * ホーム画面の接続フォーム横に置いた歯車アイコンから開き、3カラム画面から離れずに次のことができる。
 *
 * - 復元時に保存データが壊れていた場合(`wasCorrupted`)は、デフォルトに戻した旨を伝える
 * - 開くたびに環境診断(`runBrowserDiagnosis` → `describeDiagnosis`)を実行し、Prompt API / Language Detector が
 *   使えない環境ではその理由を表示する(chat-sensei は暗黙にクラウド API へ切り替えないため、理由を利用者にそのまま伝える)
 * - 保存されている設定を LocalStorage から削除してデフォルトに戻す
 *
 * 言語設定(学ぶ言語 / 解説言語)は配信ごとに変わるため、ここではなく各列の見出しのダイアログ
 * (`language-dialogs.tsx`)から設定する。
 * ストアが LocalStorage から未復元の間(`hydrated === false`)はトリガーを無効にし、
 * 復元前に初期化して永続化済みの設定を消してしまう事故を防ぐ。
 */
"use client";

import { useEffect, useState } from "react";
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
import { describeDiagnosis, type DiagnosisMessage } from "@/lib/ai/describeDiagnosis";
import { runBrowserDiagnosis } from "@/lib/ai/runBrowserDiagnosis";
import { cn } from "@/lib/utils";
import { clearSettingsStore, useSettingsStore } from "@/store/settings";

const DIALOG_TITLE = "Settings";

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
  const hydrated = useSettingsStore((state) => state.hydrated);
  const wasCorrupted = useSettingsStore((state) => state.wasCorrupted);

  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {/* 未復元の間に初期化すると、まだ読み込んでいない LocalStorage の設定を消してしまうため、復元が済むまで開けないようにする */}
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={DIALOG_TITLE} disabled={!hydrated} />}>
        <SettingsIcon />
      </DialogTrigger>
      <DialogContent aria-label={DIALOG_TITLE}>
        <DialogHeader>
          <DialogTitle>{DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            Check whether this browser can run the on-device AI. Learning languages and the explanation language are
            set from the Raw IRC and Translation column headers.
          </DialogDescription>
        </DialogHeader>

        {wasCorrupted && (
          <p className="text-xs text-destructive" role="alert">
            Your saved settings were corrupted and have been reset to the defaults. Save any setting again to clear
            this notice.
          </p>
        )}

        <DiagnosisSection open={open} />

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={clearSettingsStore}>
            Reset settings
          </Button>
          <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <section aria-label="Environment check" className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 className="text-sm font-semibold">Environment check</h3>
      {state.status === "loading" && <p className="text-xs text-muted-foreground">Checking...</p>}
      {state.status === "error" && (
        <p className="text-xs text-destructive" role="alert">
          Environment check failed: {state.errorMessage}
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
