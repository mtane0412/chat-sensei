/**
 * 接続中(connecting / open / reconnecting)にだけ表示する共通ヘッダー。
 *
 * 左にアプリ名のリンク、中央にチャンネル検索(`ChannelSearchForm` の navbar バリアント。
 * 視聴中に別のチャンネルへ移動する用途)、右に言語ペアのセレクト(文章型レイアウト)と
 * 設定ダイアログのトリガーを表示する。
 *
 * 未接続(idle / closed)のトップページは、言語設定・AIモデル設定・チャンネル検索を
 * 画面中央に置いたヘッダーなしのウェルカム画面(`src/app/page.tsx`)にするため、
 * ここでは何も描画しない。接続状態は chat-connection ストアを購読して判定する。
 */
"use client";

import Link from "next/link";
import { ChannelSearchForm } from "@/components/channel-search-form";
import { LanguagePairSelect } from "@/components/language-pair-select";
import { SettingsDialog } from "@/components/settings-dialog";
import { isConnectingOrConnected, useChatConnectionStore } from "@/store/chat-connection";

export function SiteHeader() {
  const connectionState = useChatConnectionStore((state) => state.connectionState);
  if (!isConnectingOrConnected(connectionState)) return null;

  return (
    // Surface 色で配信embedと地続きに見せる(issue #87)
    <header className="border-b bg-card">
      {/* 左右の幅を 1fr で揃え、チャンネル検索をヘッダーの中央に置く */}
      <nav className="mx-auto grid w-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-6 py-2">
        <Link href="/" className="justify-self-start font-heading text-lg font-semibold">
          chat-sensei
        </Link>
        <ChannelSearchForm variant="navbar" />
        <div className="flex items-center gap-2 justify-self-end">
          <LanguagePairSelect />
          <SettingsDialog />
        </div>
      </nav>
    </header>
  );
}
