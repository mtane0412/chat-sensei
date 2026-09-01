/**
 * 全ページ共通のヘッダー。
 *
 * 現時点ではホーム(/)のみが存在するため、アプリ名のリンクだけを表示する。
 * 画面が増えた際にここへナビゲーションを追加する。
 */
import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b bg-background">
      <nav className="mx-auto flex w-full items-center justify-between px-6 py-3">
        <Link href="/" className="font-heading text-lg font-semibold">
          chat-sensei
        </Link>
      </nav>
    </header>
  );
}
