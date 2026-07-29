/**
 * src/components/candidate-panel.tsx のテスト。
 *
 * 自動抽出パイプラインが生成した候補(Candidate)を1件ずつ提示し、
 * 採用/却下ボタンのクリックで onAccept/onReject が呼ばれることを検証する。
 * DB操作(採用/却下の実処理)はこのコンポーネントの責務外(呼び出し元に委譲)のため、
 * ここではコールバックが正しい候補idで呼ばれることのみを確認する。
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CandidatePanel } from "./candidate-panel";
import type { Candidate } from "@/lib/db/schema";

/** テスト用の候補データ(意味の分かる日本語文字列を使用) */
function buildCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 1,
    term: "clutch",
    kind: "word",
    meaning: "土壇場での見事なプレー",
    note: "対戦ゲームの実況・チャットでよく使われる",
    sourceMessageText: "that was such a clutch play honestly",
    sourceChannel: "zackrawrr",
    sourceAuthor: "yamada_taro",
    targetLang: "en",
    explainLang: "ja",
    tags: [],
    createdAt: new Date("2026-07-29T10:00:00.000Z").getTime(),
    ...overrides,
  };
}

describe("CandidatePanel", () => {
  it("候補が空の場合は何も表示しない", () => {
    const { container } = render(<CandidatePanel candidates={[]} onAccept={vi.fn()} onReject={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it("先頭の候補が用語・意味・メモ・出典付きで表示され、残り件数が見出しに表示される", () => {
    const first = buildCandidate({ id: 1, term: "clutch" });
    const second = buildCandidate({ id: 2, term: "GG" });
    render(<CandidatePanel candidates={[first, second]} onAccept={vi.fn()} onReject={vi.fn()} />);

    expect(screen.getByText("自動抽出候補")).toBeInTheDocument();
    expect(screen.getByText("2件")).toBeInTheDocument();
    expect(screen.getByText("clutch")).toBeInTheDocument();
    expect(screen.getByText("土壇場での見事なプレー")).toBeInTheDocument();
    expect(screen.getByText("対戦ゲームの実況・チャットでよく使われる")).toBeInTheDocument();
    expect(screen.getByText(/that was such a clutch play honestly/)).toBeInTheDocument();
    // 2件目(GG)は先頭ではないため、用語としては表示されない
    expect(screen.queryByText("GG")).not.toBeInTheDocument();
  });

  it("採用ボタンを押すと、先頭候補のidでonAcceptが呼ばれる", async () => {
    const user = userEvent.setup();
    const onAccept = vi.fn();
    const candidate = buildCandidate({ id: 42 });
    render(<CandidatePanel candidates={[candidate]} onAccept={onAccept} onReject={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "採用" }));

    expect(onAccept).toHaveBeenCalledWith(42);
  });

  it("却下ボタンを押すと、先頭候補のidでonRejectが呼ばれる", async () => {
    const user = userEvent.setup();
    const onReject = vi.fn();
    const candidate = buildCandidate({ id: 42 });
    render(<CandidatePanel candidates={[candidate]} onAccept={vi.fn()} onReject={onReject} />);

    await user.click(screen.getByRole("button", { name: "却下" }));

    expect(onReject).toHaveBeenCalledWith(42);
  });
});
