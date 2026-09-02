/**
 * 範囲選択による手動Pick upの選択UI(issue #72)。
 *
 * 生IRC列(`data-column="raw-irc"` を持つ列)の中の、1つの発言の本文(`data-message-text`)に
 * 収まる範囲選択に対してだけ、選択範囲の近くにフローティングの「Pick up」ボタンを表示する。
 * 行全体ではなく本文に限定するのは、行には表示名・バッジも含まれ、行単位の判定では
 * 「表示名: 本文」のような選択までPick upできてしまうため(レビュー C8)。
 * ボタンを押すと、対象の発言IDと選択した語句(trim済み)を `onPickup` へ渡し、選択を解除する。
 *
 * - 対象メッセージの特定には `window.getSelection()` のアンカー/フォーカスノードから
 *   最も近い本文要素とその祖先の `[data-message-id]` を使う。複数の発言をまたぐ選択は対象を特定できないため表示しない
 * - `selectionchange` はマウス・タッチのドラッグ中にも連続して発火するため、選択の確定を
 *   待たずに毎回状態を計算し直す(IME・タッチ選択でも、最終的な選択に対してボタンが出る)。
 *   スクロールでは `selectionchange` が発火しないため、scroll(capture)でも位置を計算し直す
 * - ボタンの mousedown が選択を解除してしまうと click が発火しなくなるため、
 *   mousedown / pointerdown の既定動作を抑止して選択を保つ
 * - まずは生IRC列(順方向)に限定する。翻訳列(逆方向の訳文)からの選択は発展スコープ(issue #72)
 */
"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/** 生IRC列を識別する `data-column` 属性の値。列側(page.tsx の Column)とセレクタの両方で使う */
export const RAW_IRC_COLUMN_NAME = "raw-irc";

/**
 * 発言本文のテキストを囲む要素に付ける data 属性名。行(`data-message-id`)には表示名・バッジも
 * 含まれるため、選択の判定は本文だけに限定する(レビュー C8。表示名込みの選択をPick upさせない)
 */
export const MESSAGE_TEXT_ATTRIBUTE = "data-message-text";

/** 現在の範囲選択から特定した手動Pick upの対象 */
interface SelectionTarget {
  /** 選択範囲を含む発言のID(`data-message-id`) */
  messageId: string;
  /** 選択した語句(trim済み) */
  term: string;
  /** 選択範囲のビューポート座標(フローティングボタンの表示位置) */
  top: number;
  left: number;
}

/**
 * ノードから最も近い、生IRC列内の発言本文要素(`data-message-text`)を返す。
 * 本文の外(表示名・バッジなど)や生IRC列の外なら null
 */
function closestRawIrcMessageText(node: Node | null): Element | null {
  if (node === null) return null;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest(`[data-column="${RAW_IRC_COLUMN_NAME}"] [data-message-id] [${MESSAGE_TEXT_ATTRIBUTE}]`) ?? null;
}

/** 現在の範囲選択を読み取り、手動Pick upの対象になる場合だけその情報を返す */
function readSelectionTarget(): SelectionTarget | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchorText = closestRawIrcMessageText(selection.anchorNode);
  const focusText = closestRawIrcMessageText(selection.focusNode);
  if (anchorText === null || anchorText !== focusText) return null;
  const row = anchorText.closest("[data-message-id]");
  const messageId = row?.getAttribute("data-message-id");
  if (!row || !messageId) return null;
  const term = selection.toString().trim();
  if (term === "") return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  return { messageId, term, top: rect.top, left: rect.left };
}

/** ボタンを選択範囲のどれだけ上に出すか(px)。選択テキストを隠さないための余白込みの高さぶん */
const BUTTON_OFFSET_PX = 36;

/**
 * 範囲選択を監視し、手動Pick upの「Pick up」ボタンをフローティング表示するオーバーレイ。
 * ホーム画面(`page.tsx`)に1つだけ置く。
 */
export function ManualPickupOverlay({
  onPickup,
}: {
  /** ボタンが押されたときに、対象の発言IDと選択した語句(trim済み)を受け取る */
  onPickup: (messageId: string, term: string) => void;
}) {
  const [target, setTarget] = useState<SelectionTarget | null>(null);

  useEffect(() => {
    const update = () => setTarget(readSelectionTarget());
    document.addEventListener("selectionchange", update);
    // スクロール(ScrollAreaのビューポートを含む)で選択範囲のビューポート座標が変わるため、位置を計算し直す
    document.addEventListener("scroll", update, { capture: true, passive: true });
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("scroll", update, { capture: true });
    };
  }, []);

  if (target === null) return null;

  return (
    <Button
      size="sm"
      className="fixed z-50 shadow-md"
      style={{ top: Math.max(target.top - BUTTON_OFFSET_PX, 8), left: target.left }}
      // ボタンへの mousedown / pointerdown が選択を解除すると、ボタンが消えて click が発火しないため抑止する
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        onPickup(target.messageId, target.term);
        document.getSelection()?.removeAllRanges();
        setTarget(null);
      }}
    >
      Pick up
    </Button>
  );
}
