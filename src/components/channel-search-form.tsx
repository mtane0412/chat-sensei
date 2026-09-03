/**
 * チャンネル検索 + 接続の共通フォーム。
 *
 * オートコンプリート付きの入力欄(`ChannelAutocompleteInput`)にチャンネル名を入力し、
 * フォーム送信(Enter / ボタン)で正規化したチャンネル名のページ(/[channel])へ遷移する。
 * IRC 接続はチャンネルページが URL を起点に開始する(このフォームは接続を直接開始しない)。
 * モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要なため、
 * 送信操作の延長で翻訳・Pick up のセッションを先にウォームアップする。
 *
 * 2つの置き場所に対応する:
 *
 * - `variant="hero"`: 未接続時のウェルカム画面用。Channel ラベル + 大きめの入力欄 +
 *   Connect ボタン + 接続状態(Status)の表示
 * - `variant="navbar"`: 接続中のヘッダー中央用。コンパクトな検索入力 + 検索アイコンの
 *   送信ボタン。接続中に別のチャンネルへ移動する用途のため Status は表示しない
 *
 * IME 変換確定の Enter はフォーム送信を起こさない(ブラウザが composition 中の Enter を
 * submit として扱わない)ため、ここでの追加対策は不要。候補選択の Enter の IME 対応は
 * `ChannelAutocompleteInput` 側で行っている。
 */
"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { SearchIcon } from "lucide-react";
import { ChannelAutocompleteInput } from "@/components/channel-autocomplete";
import { CONNECTION_STATE_LABEL } from "@/components/stream-info-panel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { normalizeChannelName } from "@/lib/twitch/irc-client";
import { useChatConnectionStore } from "@/store/chat-connection";
import { warmUpPickupPipeline } from "@/store/pickups";
import { warmUpTranslationPipeline } from "@/store/translations";

/** hero バリアントの入力欄の id(Label の htmlFor と対応させる) */
const HERO_INPUT_ID = "channel-input";

export function ChannelSearchForm({ variant }: { variant: "hero" | "navbar" }) {
  const [channelInput, setChannelInput] = useState("");
  const router = useRouter();
  const connectionState = useChatConnectionStore((state) => state.connectionState);

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const channel = channelInput.trim();
      if (channel === "") return;
      // モデル未ダウンロード時の LanguageModel.create() にはユーザー操作が必要なため、送信の延長で先に生成する
      warmUpTranslationPipeline();
      warmUpPickupPipeline();
      // 接続はチャンネルページ(/[channel])が URL を起点に開始する。URL は IRC 接続時と同じ規則で正規化する
      router.push(`/${normalizeChannelName(channel)}`);
      // 遷移後に検索語・候補ドロップダウンを残さない(オートコンプリート側が空値でドロップダウンを閉じる)
      setChannelInput("");
    },
    [channelInput, router],
  );

  if (variant === "navbar") {
    return (
      <form onSubmit={handleSubmit} className="flex w-full max-w-sm items-center gap-1">
        <ChannelAutocompleteInput
          aria-label="Search channel"
          placeholder="Search channel"
          className="h-8"
          value={channelInput}
          onValueChange={setChannelInput}
        />
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="Connect">
          <SearchIcon />
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-1.5">
      <Label htmlFor={HERO_INPUT_ID}>Channel</Label>
      <div className="flex items-center gap-2">
        <ChannelAutocompleteInput
          id={HERO_INPUT_ID}
          placeholder="e.g. zackrawrr"
          value={channelInput}
          onValueChange={setChannelInput}
        />
        <Button type="submit" disabled={channelInput.trim().length === 0}>
          Connect
        </Button>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        Status: <span>{CONNECTION_STATE_LABEL[connectionState]}</span>
      </p>
    </form>
  );
}
