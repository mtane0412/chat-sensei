/**
 * src/components/twitch-embed-player.tsx のテスト。
 *
 * Twitch公式の埋め込みプレイヤー(`https://player.twitch.tv/`)をiframeで表示する
 * コンポーネントが、指定チャンネル・現在のホスト名(parentパラメータ)を正しく
 * srcに反映することを検証する。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TwitchEmbedPlayer } from "./twitch-embed-player";

describe("TwitchEmbedPlayer", () => {
  it("指定したチャンネル名と現在のホスト名(parent)を含むiframeを表示する", () => {
    render(<TwitchEmbedPlayer channel="zackrawrr" />);

    const iframe = screen.getByTitle("Twitch配信プレイヤー: zackrawrr");
    expect(iframe.tagName).toBe("IFRAME");
    const src = new URL(iframe.getAttribute("src") ?? "");
    expect(src.origin + src.pathname).toBe("https://player.twitch.tv/");
    expect(src.searchParams.get("channel")).toBe("zackrawrr");
    // jsdomのデフォルトのホスト名(localhost)がTwitch embedのparentパラメータに渡っている
    expect(src.searchParams.get("parent")).toBe("localhost");
  });

  it("自動再生時にブラウザの自動再生ポリシーでブロックされないよう、既定でミュート再生する", () => {
    render(<TwitchEmbedPlayer channel="zackrawrr" />);

    const iframe = screen.getByTitle("Twitch配信プレイヤー: zackrawrr");
    const src = new URL(iframe.getAttribute("src") ?? "");
    expect(src.searchParams.get("muted")).toBe("true");
  });

  it("channelが変わると、iframeのsrcも新しいチャンネル名に更新される", () => {
    const { rerender } = render(<TwitchEmbedPlayer channel="zackrawrr" />);
    rerender(<TwitchEmbedPlayer channel="shroud" />);

    const iframe = screen.getByTitle("Twitch配信プレイヤー: shroud");
    const src = new URL(iframe.getAttribute("src") ?? "");
    expect(src.searchParams.get("channel")).toBe("shroud");
  });
});
