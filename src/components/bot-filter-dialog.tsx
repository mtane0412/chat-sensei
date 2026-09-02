/**
 * bot除外設定のダイアログ。
 *
 * 生IRC列の見出しに置いたアイコンボタンから開き、チャット欄から除外する bot の
 * ユーザー名パターンを1行1件で編集する。`*` はワイルドカードで、配信者ごとに
 * 個別アカウントで運用される翻訳bot(`*trans`)などを一括で除外できる。
 * 配信者アカウントで bot 的なコメント(定型文・アラート等)を流す配信者も多いため、
 * 記述欄の上のトグルで配信者自身の発言をまとめて非表示にできる。
 *
 * 保存すると `useBotFilterStore.setBotFilter` が LocalStorage へ永続化し、
 * `chat-connection.ts` が表示中の発言からも一致するものを取り除く。
 * 復元時に保存データが壊れていた場合(`wasCorrupted`)は、デフォルトに戻した旨をここで利用者に伝える。
 */
"use client";

import { useState } from "react";
import { BotOffIcon } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { formatBotFilterPatterns, parseBotFilterPatterns } from "@/lib/bot-filter";
import { useBotFilterStore } from "@/store/bot-filter";

const DIALOG_TITLE = "Bot filter";
const TEXTAREA_ID = "bot-filter-patterns";
const BROADCASTER_SWITCH_ID = "bot-filter-exclude-broadcaster";
const TEXTAREA_ROWS = 10;

export function BotFilterDialog() {
  const patterns = useBotFilterStore((state) => state.patterns);
  const excludeBroadcaster = useBotFilterStore((state) => state.excludeBroadcaster);
  const wasCorrupted = useBotFilterStore((state) => state.wasCorrupted);
  const setBotFilter = useBotFilterStore((state) => state.setBotFilter);

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftExcludeBroadcaster, setDraftExcludeBroadcaster] = useState(false);

  const handleOpenChange = (nextOpen: boolean) => {
    // 開くたびにストアの現在値から下書きを作り直す(前回の未保存の編集を持ち越さない)
    if (nextOpen) {
      setDraft(formatBotFilterPatterns(patterns));
      setDraftExcludeBroadcaster(excludeBroadcaster);
    }
    setOpen(nextOpen);
  };

  const handleSave = () => {
    setBotFilter({ patterns: parseBotFilterPatterns(draft), excludeBroadcaster: draftExcludeBroadcaster });
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger render={<Button variant="ghost" size="icon-sm" aria-label={DIALOG_TITLE} />}>
        <BotOffIcon />
      </DialogTrigger>
      <DialogContent aria-label={DIALOG_TITLE}>
        <DialogHeader>
          <DialogTitle>{DIALOG_TITLE}</DialogTitle>
          <DialogDescription>
            Enter one username per line to hide. <code>*</code> matches any characters (e.g. <code>*trans</code>,{" "}
            <code>*bot</code>).
          </DialogDescription>
        </DialogHeader>
        {wasCorrupted && (
          <p className="text-xs text-destructive" role="alert">
            Your saved settings were corrupted and have been reset to the defaults. Save again to clear this notice.
          </p>
        )}
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={BROADCASTER_SWITCH_ID}>Hide the streamer&apos;s own messages</Label>
          <Switch
            id={BROADCASTER_SWITCH_ID}
            checked={draftExcludeBroadcaster}
            onCheckedChange={(checked) => setDraftExcludeBroadcaster(checked)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={TEXTAREA_ID}>Usernames to hide</Label>
          <Textarea
            id={TEXTAREA_ID}
            rows={TEXTAREA_ROWS}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={"nightbot\n*trans"}
            className="font-mono"
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
