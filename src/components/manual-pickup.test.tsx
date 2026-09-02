/**
 * src/components/manual-pickup.tsx(範囲選択による手動Pick upの選択UI)のテスト。
 *
 * 生IRC列(`data-column="raw-irc"`)内の1つの発言行(`data-message-id`)に収まる
 * 範囲選択に対してだけフローティングの「Pick up」ボタンを表示し、押すと選択した語句と
 * 発言IDをコールバックへ渡すことを検証する(issue #72)。
 * jsdom の Selection API(createRange / getSelection)で選択を再現し、
 * `selectionchange` イベントは自動発火しないため手動で dispatch する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ManualPickupOverlay } from "./manual-pickup";

function renderWithRows(onPickup = vi.fn()) {
  render(
    <div>
      <section data-column="raw-irc">
        <div data-message-id="msg-1">gg no re chat</div>
        <div data-message-id="msg-2">this is so real</div>
      </section>
      <section>
        <div data-message-id="msg-1">翻訳列のセルに相当する別列のテキスト</div>
      </section>
      <ManualPickupOverlay onPickup={onPickup} />
    </div>,
  );
  return onPickup;
}

/** 指定したテキストノードの範囲を選択し、selectionchange を発火させる */
function selectRange(startNode: Node, start: number, endNode: Node, end: number) {
  const range = document.createRange();
  range.setStart(startNode, start);
  range.setEnd(endNode, end);
  const selection = document.getSelection();
  if (!selection) throw new Error("jsdom で Selection が取得できませんでした");
  selection.removeAllRanges();
  selection.addRange(range);
  // React の state 更新を act でラップするため、fireEvent で発火させる(jsdom は選択変更で自動発火しない)
  fireEvent(document, new Event("selectionchange"));
}

/** 要素内の最初のテキストノードを返す */
function textNodeOf(element: HTMLElement): Node {
  const node = element.firstChild;
  if (!node) throw new Error("テキストノードがありません");
  return node;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
});

describe("ManualPickupOverlay", () => {
  it("生IRC列の発言行内を範囲選択すると「Pick up」ボタンを表示する", () => {
    renderWithRows();
    const node = textNodeOf(screen.getByText("gg no re chat"));

    selectRange(node, 3, node, 8); // "no re"

    expect(screen.getByRole("button", { name: "Pick up" })).toBeInTheDocument();
  });

  it("ボタンを押すと、発言IDと選択した語句(trim済み)をコールバックへ渡し、ボタンを閉じる", async () => {
    const user = userEvent.setup();
    const onPickup = renderWithRows();
    const node = textNodeOf(screen.getByText("gg no re chat"));
    selectRange(node, 2, node, 9); // " no re " (前後に空白)

    await user.click(screen.getByRole("button", { name: "Pick up" }));

    expect(onPickup).toHaveBeenCalledWith("msg-1", "no re");
    expect(screen.queryByRole("button", { name: "Pick up" })).not.toBeInTheDocument();
  });

  it("選択が解除された(collapsed)場合はボタンを表示しない", () => {
    renderWithRows();
    const node = textNodeOf(screen.getByText("gg no re chat"));
    selectRange(node, 3, node, 8);

    selectRange(node, 3, node, 3); // 同じ位置 = collapsed

    expect(screen.queryByRole("button", { name: "Pick up" })).not.toBeInTheDocument();
  });

  it("生IRC列以外(翻訳列など)の選択ではボタンを表示しない", () => {
    renderWithRows();
    const node = textNodeOf(screen.getByText("翻訳列のセルに相当する別列のテキスト"));

    selectRange(node, 0, node, 3);

    expect(screen.queryByRole("button", { name: "Pick up" })).not.toBeInTheDocument();
  });

  it("複数の発言行をまたぐ選択ではボタンを表示しない(対象の発言を特定できないため)", () => {
    renderWithRows();
    const node1 = textNodeOf(screen.getByText("gg no re chat"));
    const node2 = textNodeOf(screen.getByText("this is so real"));

    selectRange(node1, 3, node2, 4);

    expect(screen.queryByRole("button", { name: "Pick up" })).not.toBeInTheDocument();
  });

  it("空白だけの選択ではボタンを表示しない", () => {
    renderWithRows();
    const node = textNodeOf(screen.getByText("gg no re chat"));

    selectRange(node, 2, node, 3); // "gg" と "no" の間の空白

    expect(screen.queryByRole("button", { name: "Pick up" })).not.toBeInTheDocument();
  });
});
