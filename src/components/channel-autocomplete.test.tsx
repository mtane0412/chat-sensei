/**
 * src/components/channel-autocomplete.tsx(チャンネル名入力のオートコンプリート)のテスト。
 *
 * 入力のデバウンス後に候補を取得してドロップダウン表示すること、クリック・キーボード操作で
 * 候補を選択して入力を確定できること、IME 変換中の Enter では選択しないこと、
 * Helix が利用できない場合(取得結果 null)は候補を出さず手入力だけで動作することを検証する。
 * チャンネル検索(`fetchChannelSuggestions`)はフェイクを注入し、実際の API 呼び出しは行わない。
 * デバウンスの経過はフェイクタイマーで進める(userEvent はフェイクタイマーと相性が悪いため
 * fireEvent で入力・キー操作を再現する)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ChannelSuggestion } from "@/lib/twitch/channel-search";
import { ChannelAutocompleteInput, SUGGESTION_DEBOUNCE_MS } from "./channel-autocomplete";
import { useState } from "react";

/** 検索結果のサンプル候補 */
const サンプル候補: ChannelSuggestion[] = [
  { login: "zackrawrr", displayName: "ZackRawrr", isLive: true },
  { login: "zackfair", displayName: "ザックス", isLive: false },
];

/** 親(ホーム画面)と同じく value を state で制御するテスト用ラッパー */
function ControlledInput({
  fetchSuggestions,
}: {
  fetchSuggestions: (query: string, options: { signal?: AbortSignal }) => Promise<ChannelSuggestion[] | null>;
}) {
  const [value, setValue] = useState("");
  return (
    <ChannelAutocompleteInput
      id="channel-input"
      aria-label="Channel"
      value={value}
      onValueChange={setValue}
      fetchSuggestions={fetchSuggestions}
    />
  );
}

/** 入力欄に文字列を入力する(change イベント) */
function typeInto(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

/** デバウンス時間を経過させ、取得の Promise を解決させる */
async function advanceDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(SUGGESTION_DEBOUNCE_MS);
    // fetchSuggestions の Promise 解決(マイクロタスク)を消化する
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChannelAutocompleteInput", () => {
  it("入力からデバウンス経過後に候補を取得し、ドロップダウンに login・表示名・ライブ状態を表示する", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    typeInto(screen.getByLabelText("Channel"), "zack");
    await advanceDebounce();

    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
    expect(fetchSuggestions).toHaveBeenCalledWith("zack", { signal: expect.any(AbortSignal) });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent("zackrawrr");
    expect(options[0]).toHaveTextContent("LIVE");
    expect(options[1]).toHaveTextContent("zackfair");
    expect(options[1]).toHaveTextContent("ザックス");
    expect(options[1]).not.toHaveTextContent("LIVE");
  });

  it("連続入力ではデバウンスされ、最後の入力文字列で1回だけ取得する", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    for (const partial of ["z", "za", "zac", "zack", "zackr"]) {
      typeInto(input, partial);
      // デバウンス時間内(半分だけ経過)に次の入力が続く
      act(() => vi.advanceTimersByTime(SUGGESTION_DEBOUNCE_MS / 2));
    }
    await advanceDebounce();

    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
    expect(fetchSuggestions).toHaveBeenCalledWith("zackr", { signal: expect.any(AbortSignal) });
  });

  it("候補のクリック(mousedown)で入力値が login に確定し、ドロップダウンが閉じる", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    typeInto(screen.getByLabelText("Channel"), "zack");
    await advanceDebounce();
    fireEvent.mouseDown(screen.getAllByRole("option")[1]);

    expect(screen.getByLabelText("Channel")).toHaveValue("zackfair");
    expect(screen.queryByRole("listbox")).toBeNull();
    // 選択による値の変化では再取得しない
    await advanceDebounce();
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
  });

  it("ArrowDown で候補を選び、Enter で入力値に確定できる", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    typeInto(input, "zack");
    await advanceDebounce();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(input).toHaveValue("zackfair");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("IME 変換中(isComposing)の Enter では候補を確定しない", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    typeInto(input, "zack");
    await advanceDebounce();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    // 変換確定の Enter なので入力値はそのまま・ドロップダウンも開いたまま
    expect(input).toHaveValue("zack");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("Escape でドロップダウンを閉じる", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    typeInto(input, "zack");
    await advanceDebounce();
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("入力欄からフォーカスが外れたらドロップダウンを閉じる", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    typeInto(input, "zack");
    await advanceDebounce();
    fireEvent.blur(input);

    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("取得結果が null(Helix 利用不可)の場合は候補を表示せず、手入力だけで動作する", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(null);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    typeInto(screen.getByLabelText("Channel"), "zack");
    await advanceDebounce();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(screen.getByLabelText("Channel")).toHaveValue("zack");
  });

  it("空(空白のみ)の入力では候補を取得しない", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    typeInto(screen.getByLabelText("Channel"), "  ");
    await advanceDebounce();

    expect(fetchSuggestions).not.toHaveBeenCalled();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("入力を空に戻すとドロップダウンを閉じ、取得もしない", async () => {
    const fetchSuggestions = vi.fn().mockResolvedValue(サンプル候補);
    render(<ControlledInput fetchSuggestions={fetchSuggestions} />);

    const input = screen.getByLabelText("Channel");
    typeInto(input, "zack");
    await advanceDebounce();
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    typeInto(input, "");
    await advanceDebounce();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(fetchSuggestions).toHaveBeenCalledTimes(1);
  });
});
