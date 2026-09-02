/**
 * Twitch チャットへの接続状態・受信済み発言を保持する、モジュールスコープの永続ストア。
 *
 * 今後ホーム(/)以外の画面(設定など)が追加されると、Next.js App Router 上の
 * 別ルートへの遷移でホーム画面のコンポーネントはアンマウントされる。
 *
 * 接続状態・発言一覧をホーム画面のコンポーネントローカルな state / ref として
 * 持たせると、アンマウントと同時に `TwitchIrcClient`・WebSocket への唯一の参照が
 * 消えてしまい、実際の接続も切断されてしまう。このストアはそれらを React の
 * コンポーネントツリーの外(モジュールスコープの Zustand ストア)に保持することで、
 * どの画面を表示していても接続を維持する。
 *
 * 接続中のチャンネル名(`channel`)も併せて保持し、`TwitchEmbedPlayer`(配信embed)の
 * 表示切り替えに使う。
 *
 * bot除外(`store/bot-filter.ts`)はここで適用する。除外パターンに一致するユーザー名の発言は
 * 受信時点で捨て、表示用の `messages` にもリスナー(翻訳パイプライン等)にも流さない。
 * パターンが変更されたときは、表示中の発言からも一致するものを取り除く。
 */
import { create } from "zustand";
import {
  createTwitchIrcClient,
  normalizeChannelName,
  type ConnectionState,
  type TwitchIrcClient,
} from "@/lib/twitch/irc-client";
import type { TwitchChatMessage } from "@/lib/twitch/irc-parser";
import { mergeCheermotePositions } from "@/lib/twitch/cheermotes";
import { mergeThirdPartyEmotePositions } from "@/lib/twitch/third-party-emotes";
import { matchesBotFilter } from "@/lib/bot-filter";
import { isExcludedByBotFilter, useBotFilterStore } from "./bot-filter";
import { clearThirdPartyEmotes, getThirdPartyEmoteMap, loadThirdPartyEmotes } from "./third-party-emotes";

/** チャットに表示する発言の最大保持件数(古いものから捨てるリングバッファ) */
const MAX_DISPLAYED_MESSAGES = 300;

interface ChatConnectionState {
  connectionState: ConnectionState;
  messages: TwitchChatMessage[];
  /** 接続中のチャンネル名(正規化済み)。配信embed(TwitchEmbedPlayer)の表示に使う。未接続時はnull */
  channel: string | null;
  connect: (channel: string) => void;
  disconnect: () => void;
}

/** 発言受信時に翻訳・Pick up 生成などの追加処理を行うためのリスナー */
type ChatMessageListener = (message: TwitchChatMessage) => void;
const messageListeners = new Set<ChatMessageListener>();

let client: TwitchIrcClient | null = null;

/**
 * `TwitchIrcClient` を遅延生成する。生成は初回接続時の1度きりとし、
 * 以降はページ遷移をまたいでも同一インスタンスを使い回す。
 */
function getClient(): TwitchIrcClient {
  if (!client) {
    client = createTwitchIrcClient({
      onStateChange: (state) => useChatConnectionStore.setState({ connectionState: state }),
      onEvent: (event) => {
        if (event.type === "roomstate") {
          // room-id(配信者の Twitch ユーザー ID)が判明した時点でサードパーティ emote を読み込む
          if (event.state.roomId !== null) void loadThirdPartyEmotes(event.state.roomId);
          return;
        }
        if (event.type !== "privmsg") return;
        if (isExcludedByBotFilter(event.message.username)) return;
        // 本文中の Cheermote(bits 付き発言)とサードパーティ emote 名(BTTV / FFZ / 7TV)を
        // 位置情報として合成してから保持・通知する。下流(描画・翻訳・Pick up)は
        // Twitch 公式 emote と同じ扱いで処理できる
        const emotesWithCheermotes = mergeCheermotePositions(
          event.message.text,
          event.message.emotes,
          event.message.bits,
        );
        const message: TwitchChatMessage = {
          ...event.message,
          emotes: mergeThirdPartyEmotePositions(event.message.text, emotesWithCheermotes, getThirdPartyEmoteMap()),
        };
        useChatConnectionStore.setState((prev) => {
          const next = [...prev.messages, message];
          return {
            messages:
              next.length > MAX_DISPLAYED_MESSAGES ? next.slice(next.length - MAX_DISPLAYED_MESSAGES) : next,
          };
        });
        messageListeners.forEach((listener) => listener(message));
      },
    });
  }
  return client;
}

export const useChatConnectionStore = create<ChatConnectionState>((set) => ({
  connectionState: "idle",
  messages: [],
  channel: null,
  connect: (channel) => {
    // 前のチャンネルのサードパーティ emote 対応表を持ち越さない(ROOMSTATE 受信後に再読み込みされる)
    clearThirdPartyEmotes();
    set({ messages: [], channel: normalizeChannelName(channel) });
    getClient().connect(channel);
  },
  disconnect: () => {
    set({ channel: null });
    getClient().disconnect();
  },
}));

// 除外パターンの変更を、既に表示中の発言にも遡って適用する
useBotFilterStore.subscribe((state, prevState) => {
  if (state.patterns === prevState.patterns) return;
  useChatConnectionStore.setState((prev) => {
    const messages = prev.messages.filter((message) => !matchesBotFilter(message.username, state.patterns));
    return messages.length === prev.messages.length ? prev : { messages };
  });
});

/**
 * 受信した発言(privmsg)を購読する。バックグラウンドの翻訳・Pick up 生成のように、
 * 画面表示用のリングバッファとは独立に「受信した発言そのもの」を必要とする
 * 処理から利用する。戻り値の関数を呼ぶと購読を解除できる。
 */
export function subscribeToChatMessages(listener: ChatMessageListener): () => void {
  messageListeners.add(listener);
  return () => {
    messageListeners.delete(listener);
  };
}

/**
 * テスト専用: モジュールスコープに保持している `TwitchIrcClient` とストアの状態を
 * 初期状態に戻す。本番コードではページ遷移をまたいで接続を維持するために、
 * このクライアントを意図的にモジュールスコープのシングルトンとして保持しているが、
 * その結果テストケース間で状態が漏れてしまうため、各テストの beforeEach で
 * この関数を呼び出して初期化すること。
 */
export function resetChatConnectionStoreForTests(): void {
  client = null;
  messageListeners.clear();
  useChatConnectionStore.setState({ connectionState: "idle", messages: [], channel: null });
}
