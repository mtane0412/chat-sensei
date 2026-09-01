/**
 * 発言1件の解説結果(`explanationSchema`: 訳・直訳・注目語句・難易度)を表示するコンポーネント。
 *
 * ホーム画面の右列「解説」の1行に埋め込まれる前提で、見出しは持たず縦に詰めて表示する。
 * 語句の分類(`kind`)はモデルが返す英語の識別子のままではなく日本語ラベルに変換して示す。
 * 単語帳への保存(旧「カード化」ボタン)は単語帳機能が未定のため持たない。
 */
import { Badge } from "@/components/ui/badge";
import type { ExplanationItemKind, ExplanationResult } from "@/lib/ai/schemas";

/** 語句の分類の日本語ラベル */
const KIND_LABELS: Record<ExplanationItemKind, string> = {
  slang: "スラング",
  abbreviation: "略語",
  idiom: "イディオム",
  emote: "エモート",
  grammar: "文法",
  word: "単語",
};

/** `explanationSchema.difficulty` の上限(1〜5段階) */
const MAX_DIFFICULTY = 5;

export function ExplanationResultView({ result }: { result: ExplanationResult }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <p>{result.translation}</p>
        <Badge variant="outline" className="shrink-0">
          難易度 {result.difficulty}/{MAX_DIFFICULTY}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium">直訳: </span>
        {result.literal}
      </p>
      {result.items.length > 0 && (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">注目ポイント</p>
          <ul className="flex flex-col gap-1">
            {result.items.map((item, index) => (
              <li key={index} className="rounded-md border px-2 py-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{item.term}</span>
                  <Badge variant="secondary">{KIND_LABELS[item.kind]}</Badge>
                </div>
                <p className="text-muted-foreground">{item.meaning}</p>
                <p className="text-xs text-muted-foreground">{item.note}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
