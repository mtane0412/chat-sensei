/**
 * src/app/page.tsx(ホーム = 3カラムのチャット閲覧画面)のテスト。
 *
 * 生IRC / 翻訳 / 解説 の3列が描画されること、受信済み発言が生IRC列に
 * 表示されること、翻訳列・解説列のぼかしをトグルで切り替えられることを検証する。
 * IRC 接続そのものは chat-connection ストアに閉じているため、ここでは
 * ストアの state を直接書き換えて発言を注入する。
 */
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Home from "./page";
import { resetChatConnectionStoreForTests, useChatConnectionStore } from "@/store/chat-connection";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";

const サンプル発言: TwitchChatMessage = {
  id: "msg-1",
  channel: "example",
  userId: "1234",
  username: "viewer_taro",
  displayName: "viewer_taro",
  color: "#ff0000",
  text: "gg no re chat",
  isAction: false,
  emotes: [],
  badges: [],
  timestampMs: 1_700_000_000_000,
};

afterEach(() => {
  resetChatConnectionStoreForTests();
});

describe("Home(3カラム構成)", () => {
  it("生IRC・翻訳・解説の3列を見出し付きで表示する", () => {
    render(<Home />);

    expect(screen.getByRole("region", { name: "生IRC" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "翻訳" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "解説" })).toBeInTheDocument();
  });

  it("受信済みの発言を生IRC列に表示名付きで表示する", () => {
    useChatConnectionStore.setState({ messages: [サンプル発言] });

    render(<Home />);

    const rawColumn = screen.getByRole("region", { name: "生IRC" });
    expect(within(rawColumn).getByText("viewer_taro")).toBeInTheDocument();
    expect(within(rawColumn).getByText("gg no re chat")).toBeInTheDocument();
  });

  it("翻訳列と解説列は初期状態でぼかされており、トグルで解除できる", async () => {
    const user = userEvent.setup();
    render(<Home />);

    const translationColumn = screen.getByRole("region", { name: "翻訳" });
    const explanationColumn = screen.getByRole("region", { name: "解説" });
    expect(translationColumn).toHaveAttribute("data-blurred", "true");
    expect(explanationColumn).toHaveAttribute("data-blurred", "true");

    await user.click(screen.getByRole("switch", { name: "翻訳をぼかす" }));
    expect(translationColumn).toHaveAttribute("data-blurred", "false");
    expect(explanationColumn).toHaveAttribute("data-blurred", "true");

    await user.click(screen.getByRole("switch", { name: "解説をぼかす" }));
    expect(explanationColumn).toHaveAttribute("data-blurred", "false");
  });
});
