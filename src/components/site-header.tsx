/**
 * 全ページ共通のヘッダー。
 *
 * chat-sensei はページ数の少ないシングルパーパスアプリのため、
 * ナビゲーションは実装済みのページ(ホーム / 設定)のみを表示する。
 * 単語帳(/deck)・復習(/study)は Phase 3・5 でページ実装後にリンクを追加する。
 */
import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b bg-background">
      <nav className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-3">
        <Link href="/" className="font-heading text-lg font-semibold">
          chat-sensei
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <Link href="/settings" className="text-muted-foreground transition-colors hover:text-foreground">
            設定
          </Link>
        </div>
      </nav>
    </header>
  );
}
