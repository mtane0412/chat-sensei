/**
 * 言語ペアタグ付き配信一覧(issue #90)。
 *
 * 未接続時のウェルカム画面で、チャンネル接続UIの下に「選択中の言語ペア
 * (学習言語・解説言語)の両方の言語タグを含むライブ配信」の一覧をカードで表示する。
 * カードをクリックするとそのチャンネルのページ(/[channel])へ遷移する
 * (IRC 接続はチャンネルページが URL を起点に開始する。チャンネル検索フォームと同様に、
 * モデル未ダウンロード時の `LanguageModel.create()` にはユーザー操作が必要なため、
 * クリックの延長で翻訳・Pick up のセッションを先にウォームアップする)。
 *
 * - 設定ストアの復元(hydrate)後に取得を始め、言語ペアの変更に追従して取得し直す
 * - 取得に失敗した場合(Helix 未設定の 503・障害など)はセクションごと表示しない
 *   (チャンネルオートコンプリートと同じ静かなフォールバック)
 * - 該当する配信が0件の場合は空状態の文言を表示する
 */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { LANGUAGE_DISPLAY_NAMES } from "@/lib/settings";
import { fetchLanguagePairStreams, type TaggedStream } from "@/lib/twitch/stream-list";
import { warmUpPickupPipeline } from "@/store/pickups";
import { useSettingsStore } from "@/store/settings";
import { warmUpTranslationPipeline } from "@/store/translations";

/** 視聴者数の桁区切り表示(1,234 のような英語圏形式。UI は英語で統一しているため) */
const VIEWER_COUNT_FORMAT = new Intl.NumberFormat("en-US");

/**
 * 一覧の取得結果。null = 未取得(取得中) / 取得失敗(いずれも表示しない)。
 * どの言語ペアに対する結果かを pairKey で持ち、言語ペア変更直後に古いペアの
 * 一覧を表示しない(effect 内で同期的に state をリセットせずに済ませる)
 */
interface StreamListResult {
  /** 取得時の言語ペア(`learningLang:explainLang`) */
  pairKey: string;
  /** 両タグを含む配信一覧。取得失敗時は null(セクションごと表示しない) */
  streams: TaggedStream[] | null;
}

export function LanguagePairStreamList() {
  const settings = useSettingsStore((state) => state.settings);
  const hydrated = useSettingsStore((state) => state.hydrated);
  const router = useRouter();
  const [result, setResult] = useState<StreamListResult | null>(null);

  const { learningLang, explainLang } = settings;
  const pairKey = `${learningLang}:${explainLang}`;

  useEffect(() => {
    // SSR プリレンダリングと LocalStorage 復元前はデフォルト言語ペアで誤って取得しないよう待つ
    if (!hydrated) return;
    const controller = new AbortController();
    void fetchLanguagePairStreams(learningLang, explainLang, { signal: controller.signal }).then((streams) => {
      // 言語ペア変更・アンマウントで中断された古い結果は捨てる(新しい effect 側の結果を採用する)
      if (controller.signal.aborted) return;
      setResult({ pairKey: `${learningLang}:${explainLang}`, streams });
    });
    return () => controller.abort();
  }, [hydrated, learningLang, explainLang]);

  // 未取得(取得中)・取得失敗・言語ペア変更直後(古いペアの結果)は表示しない
  if (!hydrated || result === null || result.pairKey !== pairKey || result.streams === null) return null;
  const streams = result.streams;

  const handleConnect = (login: string) => {
    // モデル未ダウンロード時の LanguageModel.create() にはユーザー操作が必要なため、クリックの延長で先に生成する
    warmUpTranslationPipeline();
    warmUpPickupPipeline();
    // 接続はチャンネルページ(/[channel])が URL を起点に開始する。login は Helix が返す正規化済みの小文字名
    router.push(`/${login}`);
  };

  return (
    <section aria-labelledby="language-pair-stream-list-heading" className="flex w-full flex-col gap-4">
      <h2 id="language-pair-stream-list-heading" className="font-heading text-lg font-semibold">
        Live streams tagged {LANGUAGE_DISPLAY_NAMES[learningLang]} · {LANGUAGE_DISPLAY_NAMES[explainLang]}
      </h2>
      {streams.length === 0 ? (
        <p className="text-sm text-muted-foreground">No live streams with both language tags right now.</p>
      ) : (
        <ul className="grid list-none grid-cols-1 gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
          {streams.map((stream) => (
            <li key={stream.login}>
              <button
                type="button"
                onClick={() => handleConnect(stream.login)}
                className="flex w-full flex-col gap-2 rounded-lg border border-border bg-card p-2 text-left transition-colors hover:border-primary/60 hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                {stream.thumbnailUrl !== "" && (
                  // 配信のプレビュー画像。タイトル等の文字情報が隣にあるため装飾扱い(alt は空)
                  // eslint-disable-next-line @next/next/no-img-element -- Twitch CDN の動的プレビューのため next/image の最適化対象にしない
                  <img
                    src={stream.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="aspect-video w-full rounded-md object-cover"
                  />
                )}
                <span className="flex flex-col gap-0.5">
                  <span className="line-clamp-2 text-sm font-medium">{stream.title}</span>
                  <span className="text-xs text-muted-foreground">{stream.displayName}</span>
                  <span className="flex items-center gap-2 text-xs text-muted-foreground">
                    {stream.category !== "" && <span className="truncate">{stream.category}</span>}
                    {stream.viewerCount !== null && (
                      // 配信者情報パネル(stream-info-panel.tsx)と同じ「赤色の人アイコン + 数字」
                      // (色はライブ配信用トークン --live)に揃える
                      <span className="flex shrink-0 items-center gap-1 font-semibold text-live">
                        <UserIcon aria-hidden="true" className="size-3" />
                        {VIEWER_COUNT_FORMAT.format(stream.viewerCount)}
                        <span className="sr-only"> viewers</span>
                      </span>
                    )}
                  </span>
                </span>
                {stream.tags.length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {stream.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
