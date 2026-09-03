/**
 * ホームページ(/)。ヘッダーなしのウェルカム画面を表示する。
 *
 * アプリ名とタグラインの下にチャンネル検索(ChannelSearchForm の hero バリアント)、
 * 言語ペアのセレクト、AIモデル設定(SettingsDialog のラベル付きトリガー)を縦に並べ、
 * その下に言語ペアの両タグを含むライブ配信の一覧(LanguagePairStreamList。issue #90)を表示する。
 *
 * チャンネルの視聴(配信embed + 3カラムのチャット閲覧)はチャンネルページ(/[channel])が担う。
 * チャンネル検索フォームは接続を直接開始せず /[channel] へ遷移し、接続はチャンネルページが
 * URL を起点に開始する。逆に、視聴中にヘッダーのロゴなどからこのページへ戻ってきた場合は、
 * マウント時に IRC 接続を切断してウェルカム画面へ戻す(URL と接続状態を一致させるため)。
 *
 * 言語設定は settings ストアが LocalStorage から復元する(言語ペアのセレクト・配信一覧が参照する)。
 */
"use client";

import { useEffect } from "react";
import { ChannelSearchForm } from "@/components/channel-search-form";
import { LanguagePairSelect } from "@/components/language-pair-select";
import { SettingsDialog } from "@/components/settings-dialog";
import { LanguagePairStreamList } from "@/components/stream-list";
import { isConnectingOrConnected, useChatConnectionStore } from "@/store/chat-connection";
import { hydrateSettingsStore } from "@/store/settings";

export default function Home() {
  // 言語ペアを LocalStorage から復元する(SSR 中に触れないようマウント後に行う)
  useEffect(() => hydrateSettingsStore(), []);

  // 視聴中(接続中)にホームへ戻ってきたら切断する。接続状態は URL(/[channel])を起点とするため、
  // ホーム表示中に接続が残っていると URL と実際の状態が食い違ってしまう
  useEffect(() => {
    const { connectionState, disconnect } = useChatConnectionStore.getState();
    if (isConnectingOrConnected(connectionState)) disconnect();
  }, []);

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4 p-4">
      {/* レイアウト(layout.tsx)が高さを固定しているため、一覧が伸びたぶんはこのラッパーの内部でスクロールする */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col items-center justify-center gap-10 py-10">
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
          <LanguagePairStreamList />
        </div>
      </div>
    </div>
  );
}
