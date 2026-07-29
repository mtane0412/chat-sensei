/**
 * 自動抽出候補のレビューパネル。
 *
 * 自動抽出パイプラインがバックグラウンドで生成した候補(Candidate)を、
 * チャット画面の横で1件ずつ提示する。レビュー順は呼び出し元(`candidates`配列)の
 * 先頭を最優先とし、通常は作成日時が古い順(=`subscribeToCandidates`の並び)を渡す想定。
 * 採用/却下はクリック操作のみ(ドラッグ・スワイプ操作は行わない)で、
 * 実際のDB更新(採用=単語帳への保存/却下=削除)は呼び出し元の`onAccept`/`onReject`に委譲する。
 */
"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Candidate } from "@/lib/db/schema";

export interface CandidatePanelProps {
  /** レビュー対象の候補一覧。先頭(candidates[0])が現在表示中のカードになる */
  candidates: Candidate[];
  onAccept: (id: number) => void;
  onReject: (id: number) => void;
}

export function CandidatePanel({ candidates, onAccept, onReject }: CandidatePanelProps) {
  if (candidates.length === 0) {
    return null;
  }

  const current = candidates[0];
  const remainingCount = candidates.length - 1;

  return (
    <Card className="flex w-full flex-col gap-3 lg:w-80 lg:shrink-0">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle>自動抽出候補</CardTitle>
        <Badge variant="secondary">{candidates.length}件</Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/*
          Tinderのような「カードが積み重なっている」見た目を、ドラッグなしの
          最小限のCSSだけで表現する装飾用プレビュー。次の候補があるときだけ、
          現在のカードの背後にわずかに覗かせる(操作対象ではないためaria-hiddenで除外)。
        */}
        {remainingCount > 0 && (
          <div
            aria-hidden="true"
            className="-mb-6 h-3 scale-95 rounded-md border bg-muted/50"
          />
        )}
        <div className="rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{current.term}</span>
            <Badge variant="secondary">{current.kind}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">{current.meaning}</p>
          {current.note && <p className="text-xs text-muted-foreground">{current.note}</p>}
          <p className="mt-1 text-xs text-muted-foreground italic">「{current.sourceMessageText}」</p>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => onAccept(current.id!)} size="sm" className="flex-1">
              採用
            </Button>
            <Button onClick={() => onReject(current.id!)} size="sm" variant="outline" className="flex-1">
              却下
            </Button>
          </div>
        </div>
        {remainingCount > 0 && (
          <p className="text-xs text-muted-foreground">他 {remainingCount} 件</p>
        )}
      </CardContent>
    </Card>
  );
}
