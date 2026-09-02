/**
 * 範囲選択による手動Pick upの選択UI(issue #72)。
 *
 * 生IRC列(`data-column="raw-irc"` を持つ列)の中の、1つの発言行(`data-message-id`)に
 * 収まる範囲選択に対してだけ、選択範囲の近くにフローティングの「Pick up」ボタンを表示する。
 * ボタンを押すと、対象の発言IDと選択した語句(trim済み)を `onPickup` へ渡し、選択を解除する。
 *
 * - 対象メッセージの特定には `window.getSelection()` のアンカー/フォーカスノードから
 *   最も近い `[data-message-id]` 要素を使う。複数行をまたぐ選択は対象を特定できないため表示しない
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

/** ノードから最も近い、生IRC列内の発言行要素を返す。生IRC列の外なら null */
function closestRawIrcMessageRow(node: Node | null): Element | null {
  if (node === null) return null;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest('[data-column="raw-irc"] [data-message-id]') ?? null;
}

/** 現在の範囲選択を読み取り、手動Pick upの対象になる場合だけその情報を返す */
function readSelectionTarget(): SelectionTarget | null {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const term = selection.toString().trim();
  if (term === "") return null;
  const anchorRow = closestRawIrcMessageRow(selection.anchorNode);
  const focusRow = closestRawIrcMessageRow(selection.focusNode);
  if (anchorRow === null || anchorRow !== focusRow) return null;
  const messageId = anchorRow.getAttribute("data-message-id");
  if (messageId === null || messageId === "") return null;
  // jsdom(テスト環境)の Range には getBoundingClientRect が存在しないため、行要素の位置で代用する
  const range: { getBoundingClientRect?: () => DOMRect } = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect?.() ?? anchorRow.getBoundingClientRect();
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
