/**
 * チャンネル名入力のオートコンプリート(issue #59)。
 *
 * ホーム画面(`src/app/page.tsx`)の Channel 入力欄として使う。入力文字列を
 * デバウンスしてチャンネル検索(`src/lib/twitch/channel-search.ts`)へ問い合わせ、
 * 候補(login・表示名・ライブ状態)をドロップダウンに表示する。
 * 候補の選択(クリック・ArrowDown/ArrowUp + Enter)で入力値を login に確定する。
 *
 * - 入力の変化ごとに前のリクエストを AbortController で中断する(遅れて届いた
 *   古い結果による上書きも防ぐ)
 * - IME 変換確定の Enter(`isComposing`)では候補を確定しない
 * - Helix が利用できない場合(取得結果 null)・候補ゼロの場合はドロップダウンを
 *   表示せず、現行どおり手入力だけで動作する(意図した仕様)
 * - value は親が制御する(接続時の値の利用・接続中の無効化は親の責務)
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { fetchChannelSuggestions, type ChannelSuggestion } from "@/lib/twitch/channel-search";

/** 入力からチャンネル検索までのデバウンス時間(ミリ秒) */
export const SUGGESTION_DEBOUNCE_MS = 300;

/** ドロップダウンのリストの id(aria-controls と対応させる) */
const LISTBOX_ID = "channel-suggestion-listbox";

/** 候補 1 件の option 要素の id(aria-activedescendant と対応させる) */
function optionId(index: number): string {
  return `channel-suggestion-option-${index}`;
}

export function ChannelAutocompleteInput({
  value,
  onValueChange,
  fetchSuggestions = fetchChannelSuggestions,
  ...inputProps
}: {
  /** 入力値(親が制御する) */
  value: string;
  /** 手入力・候補の選択による入力値の変化 */
  onValueChange: (value: string) => void;
  /** チャンネル検索(テストではフェイクを注入する) */
  fetchSuggestions?: (
    query: string,
    options: { signal?: AbortSignal },
  ) => Promise<ChannelSuggestion[] | null>;
} & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  const [suggestions, setSuggestions] = useState<ChannelSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  /** キーボードで選択中の候補の位置。未選択は -1 */
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 候補の選択で value を変えた直後は true にし、その変化による再検索を抑止する */
  const skipNextSearchRef = useRef(false);

  // 親が value を外部から空にした場合(接続フォームの送信後クリアなど)は handleInputChange を
  // 経由しないため、値の変化を render 中に検知してドロップダウンを閉じ、候補を破棄する
  // (React の「render 中の派生 state 調整」パターン。effect 内の同期 setState は使わない)
  const [prevValue, setPrevValue] = useState(value);
  if (prevValue !== value) {
    setPrevValue(value);
    if (value.trim() === "") {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
    }
  }

  // 入力の変化をデバウンスして候補を検索する。次の入力・アンマウントでタイマーと
  // 進行中のリクエストを破棄するため、古い結果が後から表示されることはない
  useEffect(() => {
    if (skipNextSearchRef.current) {
      skipNextSearchRef.current = false;
      return;
    }
    // 空入力では検索しない(空値時のドロップダウンのクローズは render 中の派生 state 調整で行う)
    const query = value.trim();
    if (query === "") return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const result = await fetchSuggestions(query, { signal: controller.signal });
        if (controller.signal.aborted) return;
        // null(Helix 利用不可)・候補ゼロはドロップダウンを出さない(手入力だけで動作する)
        setSuggestions(result ?? []);
        setOpen(result !== null && result.length > 0);
        setActiveIndex(-1);
      })();
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, fetchSuggestions]);

  /** 手入力による値の変化。空(空白のみ)になったらドロップダウンを閉じて候補を破棄する */
  const handleInputChange = (next: string) => {
    onValueChange(next);
    if (next.trim() === "") {
      setSuggestions([]);
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  /** 候補を入力値に確定してドロップダウンを閉じる */
  const selectSuggestion = (suggestion: ChannelSuggestion) => {
    skipNextSearchRef.current = true;
    onValueChange(suggestion.login);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((prev) => (prev + 1) % suggestions.length);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
        break;
      case "Enter":
        // IME 変換確定の Enter では候補を確定しない(@rules/ime-handling.md)
        if (event.nativeEvent.isComposing) return;
        if (activeIndex >= 0 && activeIndex < suggestions.length) {
          event.preventDefault();
          selectSuggestion(suggestions[activeIndex]);
        }
        break;
      case "Escape":
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
        break;
    }
  };

  return (
    // 置き場所(接続フォーム・ヘッダー検索)の行幅いっぱいに広がるよう w-full にする(幅は親が決める)
    <div className="relative w-full">
      <Input
        {...inputProps}
        role="combobox"
        aria-expanded={open}
        aria-controls={LISTBOX_ID}
        aria-autocomplete="list"
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        autoComplete="off"
        value={value}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setOpen(false)}
      />
      {open && (
        <ul
          id={LISTBOX_ID}
          role="listbox"
          aria-label="Channel suggestions"
          className="absolute top-full left-0 z-20 mt-1 max-h-64 w-full min-w-48 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {suggestions.map((suggestion, index) => (
            <li
              key={suggestion.login}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
              // フォーカスを入力欄に残したまま選択できるよう、blur を起こす mousedown で確定する
              onMouseDown={(e) => {
                e.preventDefault();
                selectSuggestion(suggestion);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              <span className="font-medium">{suggestion.login}</span>
              {suggestion.displayName !== suggestion.login && (
                <span className="truncate text-muted-foreground">{suggestion.displayName}</span>
              )}
              {suggestion.isLive && (
                <span className="ml-auto shrink-0 rounded-sm bg-red-600 px-1 text-[10px] font-semibold text-white">
                  LIVE
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
