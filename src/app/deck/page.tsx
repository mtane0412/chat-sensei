/**
 * 単語帳ページ(/deck)。
 *
 * 解説ダイアログでカード化した語句を一覧・検索・削除できる。
 * 一覧はそのままJSONファイルとしてエクスポートでき、他端末への持ち出しや
 * バックアップに使える。データはすべてブラウザのIndexedDB(Dexie)に閉じており、
 * サーバーへの送信は行わない。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { deleteCard, exportCardsToJson, listCards, searchCards } from "@/lib/db/cards";
import type { Card as DeckCard } from "@/lib/db/schema";

export default function DeckPage() {
  const [cards, setCards] = useState<DeckCard[]>([]);
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);

  // 検索語(空文字なら全件)に応じて一覧を読み直す。DBアクセスはこの関数だけに閉じ込める。
  const refresh = useCallback((q: string) => {
    const load = q.trim() === "" ? listCards() : searchCards(q);
    load.then((result) => {
      setCards(result);
      setIsLoading(false);
    });
  }, []);

  useEffect(() => {
    refresh("");
  }, [refresh]);

  const handleSearchChange = useCallback(
    (value: string) => {
      setQuery(value);
      refresh(value);
    },
    [refresh],
  );

  const handleDelete = useCallback(
    (id: number) => {
      deleteCard(id).then(() => refresh(query));
    },
    [query, refresh],
  );

  const handleExport = useCallback(() => {
    const json = exportCardsToJson(cards);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `chat-sensei-cards-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [cards]);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 p-6">
      <Card>
        <CardHeader>
          <CardTitle>単語帳</CardTitle>
          <CardDescription>カード化した語句・フレーズの一覧です。検索・削除・JSONエクスポートができます。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="deck-search-input">カードを検索</Label>
            <div className="flex gap-2">
              <Input
                id="deck-search-input"
                placeholder="語句・意味・メモで検索"
                value={query}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
              <Button onClick={handleExport} variant="outline" disabled={cards.length === 0}>
                JSONエクスポート
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="flex flex-1 flex-col overflow-hidden">
        <ScrollArea className="h-[60vh]">
          {isLoading && <p className="p-4 text-sm text-muted-foreground">読み込み中...</p>}

          {!isLoading && cards.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              カードがまだありません。ホーム画面の解説から語句をカード化してください。
            </p>
          )}

          {!isLoading && cards.length > 0 && (
            <ol className="flex flex-col gap-2 p-4">
              {cards.map((card) => (
                <li key={card.id} className="rounded-md border p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{card.term}</span>
                      <Badge variant="secondary">{card.kind}</Badge>
                    </div>
                    <Button
                      onClick={() => handleDelete(card.id!)}
                      variant="ghost"
                      size="icon"
                      aria-label="削除"
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                  <p className="text-sm text-muted-foreground">{card.meaning}</p>
                  {card.note && <p className="text-xs text-muted-foreground">{card.note}</p>}
                  <p className="mt-1 text-xs text-muted-foreground italic">「{card.sourceMessageText}」</p>
                </li>
              ))}
            </ol>
          )}
        </ScrollArea>
      </Card>
    </div>
  );
}
