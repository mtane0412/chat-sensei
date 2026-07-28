/**
 * ホームページ(/)。
 *
 * 現時点(Phase 0)ではライブチャット画面は未実装のため、
 * アプリの概要と環境診断への導線のみを表示するプレースホルダーとする。
 * Phase 1 で Twitch IRC 接続とライブチャット表示に置き換える。
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 p-6">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>chat-sensei</CardTitle>
          <CardDescription>
            Twitch のライブチャットから、自分だけの語学教材を作る。ログイン不要・サーバー不要、Chrome
            内蔵AI(Gemini Nano)だけで完結するクライアントサイド専用ツールです。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
          <p>
            ライブチャット接続機能は Phase 1 で実装予定です。まずは環境診断で、お使いの Chrome が
            Prompt API に対応しているか確認してください。
          </p>
          {/* Link(<a>要素)としてレンダリングするため、Base UI のネイティブ<button>前提を明示的に外す */}
          <Button
            render={<Link href="/settings">環境診断へ進む</Link>}
            nativeButton={false}
            className="self-start"
          />
        </CardContent>
      </Card>
    </div>
  );
}
