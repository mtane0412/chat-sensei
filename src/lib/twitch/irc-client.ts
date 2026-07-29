/**
 * Twitch IRC(`wss://irc-ws.chat.twitch.tv:443`)への匿名WebSocket接続を管理するクライアント。
 *
 * 認証なしの `justinfan<乱数>` ニックネームで接続し(実際に接続確認済み)、
 * 受信した行を `parseTwitchIrcMessage` で構造化してコールバックに渡す。
 * PING への PONG 応答、および予期しない切断時の指数バックオフ再接続もここで担う。
 *
 * WebSocket そのものはブラウザのグローバル実装を使うが、テスト容易性のため
 * `createWebSocket` として差し替え可能にしている(session-pool.ts と同様の
 * 依存性注入パターン)。
 */
import { parseTwitchIrcMessage, type TwitchChatEvent } from "./irc-parser";

const TWITCH_IRC_WS_URL = "wss://irc-ws.chat.twitch.tv:443";
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

/** クライアントが必要とする WebSocket の最小限のインターフェース(ブラウザの WebSocket と互換) */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface TwitchIrcClientCallbacks {
  /** PING/PONGを除く、パース済みイベントの通知先 */
  onEvent: (event: TwitchChatEvent) => void;
  onStateChange?: (state: ConnectionState) => void;
}

export interface TwitchIrcClientOptions {
  /** テスト時にモックWebSocketを注入するためのファクトリ。省略時はグローバルの `WebSocket` を使う */
  createWebSocket?: (url: string) => WebSocketLike;
  /** 再接続の初期待機時間(ms)。省略時 1000ms */
  initialReconnectDelayMs?: number;
  /** 再接続の待機時間の上限(ms)。省略時 30000ms */
  maxReconnectDelayMs?: number;
  /** `justinfan<数値>` の数値部分を決めるための関数。テストで固定値にするため注入可能 */
  randomSuffix?: () => number;
}

export interface TwitchIrcClient {
  connect(channel: string): void;
  disconnect(): void;
  getState(): ConnectionState;
}

/**
 * ブラウザ組み込みの `WebSocket` を、依存性注入しやすい最小限の `WebSocketLike` に変換する。
 * ネイティブの `onopen`/`onmessage`/`onclose` は Event オブジェクトを伴って呼ばれるが、
 * このクライアントはイベント本体を使わないため、ここで薄いラッパーに包んで捨てる。
 */
function defaultCreateWebSocket(url: string): WebSocketLike {
  const nativeSocket = new WebSocket(url);
  const wrapper: WebSocketLike = {
    send: (data) => nativeSocket.send(data),
    close: () => nativeSocket.close(),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  nativeSocket.onopen = () => wrapper.onopen?.();
  nativeSocket.onmessage = (event) => wrapper.onmessage?.({ data: String(event.data) });
  nativeSocket.onclose = () => wrapper.onclose?.();
  nativeSocket.onerror = (event) => wrapper.onerror?.(event);
  return wrapper;
}

function defaultRandomSuffix(): number {
  return Math.floor(Math.random() * 80_000) + 10_000;
}

/**
 * チャンネル名から先頭の `#` を除き小文字化する(Twitchのチャンネル名は大文字小文字を区別しない)。
 * 配信embed(iframe)にもIRC接続と同じ正規化済みチャンネル名を渡すため、ストア側と共有できるようexportする。
 */
export function normalizeChannelName(channel: string): string {
  return channel.replace(/^#/, "").toLowerCase();
}

/**
 * Twitch IRC への匿名接続クライアントを生成する。
 * 生成した時点では接続は開始せず、`connect(channel)` を呼んで初めて接続する。
 */
export function createTwitchIrcClient(
  callbacks: TwitchIrcClientCallbacks,
  options: TwitchIrcClientOptions = {},
): TwitchIrcClient {
  const createWebSocket = options.createWebSocket ?? defaultCreateWebSocket;
  const initialReconnectDelayMs = options.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
  const maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
  const randomSuffix = options.randomSuffix ?? defaultRandomSuffix;

  let socket: WebSocketLike | null = null;
  let state: ConnectionState = "idle";
  let currentChannel: string | null = null;
  let reconnectDelayMs = initialReconnectDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** disconnect() による意図的な切断かどうか(true の間は onclose を受けても再接続しない) */
  let isIntentionalDisconnect = false;

  function setState(next: ConnectionState) {
    state = next;
    callbacks.onStateChange?.(next);
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function openSocket(channel: string) {
    clearReconnectTimer();
    isIntentionalDisconnect = false;
    currentChannel = channel;
    setState("connecting");

    const ws = createWebSocket(TWITCH_IRC_WS_URL);
    socket = ws;

    ws.onopen = () => {
      ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      ws.send(`NICK justinfan${randomSuffix()}`);
      ws.send(`JOIN #${channel}`);
      setState("open");
    };

    ws.onmessage = (event) => {
      handleIncomingData(ws, event.data);
    };

    ws.onclose = () => {
      if (isIntentionalDisconnect) {
        setState("closed");
        return;
      }
      scheduleReconnect();
    };

    ws.onerror = () => {
      // WebSocket の error イベントは直後に close イベントも発火するため、
      // 再接続のスケジューリングは onclose 側に一本化する(重複防止)。
    };
  }

  function scheduleReconnect() {
    setState("reconnecting");
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (currentChannel) {
        openSocket(currentChannel);
      }
    }, delay);
  }

  function handleIncomingData(ws: WebSocketLike, data: string) {
    const lines = data.split("\r\n").filter((line) => line.length > 0);
    for (const line of lines) {
      const event = parseTwitchIrcMessage(line);
      switch (event.type) {
        case "ping":
          ws.send("PONG :tmi.twitch.tv");
          break;
        case "reconnect":
          // Twitchサーバーからの再接続要求。現在の接続を閉じ、間隔を初期値に戻して即座に再接続する。
          reconnectDelayMs = initialReconnectDelayMs;
          ws.close();
          break;
        default:
          callbacks.onEvent(event);
      }
    }
  }

  return {
    connect(channel: string) {
      const normalized = normalizeChannelName(channel);
      if (socket) {
        isIntentionalDisconnect = true;
        socket.close();
      }
      reconnectDelayMs = initialReconnectDelayMs; // 利用者による明示的な接続なので再接続間隔をリセットする
      openSocket(normalized);
    },
    disconnect() {
      clearReconnectTimer();
      currentChannel = null;
      if (socket) {
        isIntentionalDisconnect = true;
        socket.close();
      } else {
        setState("closed");
      }
    },
    getState() {
      return state;
    },
  };
}
