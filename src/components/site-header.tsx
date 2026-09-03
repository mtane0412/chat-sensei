/**
 * 全ページ共通のヘッダー。
 *
 * 左側にアプリ名のリンク、右側に言語ペアのセレクト(文章型レイアウト)と
 * 設定ダイアログのトリガーを表示する。言語設定・アプリ設定は接続前後の
 * どちらの画面(接続フォーム / embed + 3カラム)でも変更したくなるため、
 * 画面の状態に依存しないヘッダーに常時置く。
 */
import Link from "next/link";
import { LanguagePairSelect } from "@/components/language-pair-select";
import { SettingsDialog } from "@/components/settings-dialog";

export function SiteHeader() {
  return (
    // Surface 色で配信embedと地続きに見せる(issue #87)
    <header className="border-b bg-card">
      <nav className="mx-auto flex w-full items-center justify-between gap-4 px-6 py-2">
        <Link href="/" className="font-heading text-lg font-semibold">
          chat-sensei
        </Link>
        <div className="flex items-center gap-2">
          <LanguagePairSelect />
          <SettingsDialog />
        </div>
      </nav>
    </header>
  );
}
