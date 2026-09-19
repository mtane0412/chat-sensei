/**
 * Pick up 候補生成の実チャット評価(issue #117)に使うチャットログを収集するスクリプト。
 *
 * アプリと同じ匿名(読み取り専用)の Twitch IRC クライアントで指定チャンネルに接続し、
 * 受信した発言を `eval-data/<チャンネル名>-<開始日時>.jsonl` へ1行1発言の JSON で追記する。
 * 集計は `scripts/evaluate-pickup-candidates.ts` で行う。
 *
 * 実行方法(`scripts/run-ts-script.mjs` が `@/` エイリアス付きで実行する):
 *   npm run eval:collect -- <チャンネル名> [収集時間(分)]
 * 収集時間を省略した場合は Ctrl+C で止めるまで収集する。
 *
 * プライバシー上の注意:
 * - 保存するのは発言の時刻と、Pick up の前処理(`preparePickupInput`)を通した本文だけ。
 *   発言者のユーザー名・表示名・ユーザーIDは保存せず、本文中の @メンション・URL・emote も除去してから保存する
 * - 前処理後に本文が空になる発言(emote だけの発言など)は、Pick up が LLM を呼ばないため保存しない
 * - bot の発言はアプリ既定の bot 除外パターンで収集時に除外する
 * - `eval-data/` は `.gitignore` で除外している。ログの本文をコミット・issue・PR に転記しないこと
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { preparePickupInput } from "@/lib/ai/pickup-filter";
import { DEFAULT_BOT_FILTER_CONFIG, isExcludedFromChat } from "@/lib/bot-filter";
import { createTwitchIrcClient, normalizeChannelName } from "@/lib/twitch/irc-client";
import type { CollectedChatMessage } from "./lib/collected-chat-message";

/** 収集したログの保存先ディレクトリ(リポジトリルートからの相対パス。`.gitignore` で除外済み) */
const OUTPUT_DIRECTORY = "eval-data";
/** 収集件数を標準出力へ報告する間隔(発言数) */
const PROGRESS_REPORT_INTERVAL = 100;
const MS_PER_MINUTE = 60 * 1000;

const [channelArgument, durationArgument] = process.argv.slice(2);
if (channelArgument === undefined) {
  throw new Error("チャンネル名を指定してください: npm run eval:collect -- <チャンネル名> [収集時間(分)]");
}
const durationMinutes = durationArgument === undefined ? null : Number(durationArgument);
if (durationMinutes !== null && !(durationMinutes > 0)) {
  throw new Error(`収集時間(分)には正の数を指定してください: ${durationArgument}`);
}

const channel = normalizeChannelName(channelArgument);
const startedAt = new Date().toISOString().replace(/[:.]/g, "-");
const outputPath = path.join(OUTPUT_DIRECTORY, `${channel}-${startedAt}.jsonl`);
mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

let collectedCount = 0;

const client = createTwitchIrcClient({
  onEvent: (event) => {
    if (event.type !== "privmsg") return;
    const { message } = event;
    if (isExcludedFromChat(message.username, channel, DEFAULT_BOT_FILTER_CONFIG)) return;
    const prepared = preparePickupInput(message.text, message.emotes);
    if (prepared.text === "") return;
    const record: CollectedChatMessage = {
      // `tmi-sent-ts` タグが無い発言は受信時刻で代用する(クールダウンのシミュレーションに時刻が必須のため)
      timestampMs: message.timestampMs ?? Date.now(),
      text: prepared.text,
    };
    appendFileSync(outputPath, `${JSON.stringify(record)}\n`);
    collectedCount += 1;
    if (collectedCount % PROGRESS_REPORT_INTERVAL === 0) {
      process.stdout.write(`${collectedCount} 件収集しました\n`);
    }
  },
  onStateChange: (state) => process.stdout.write(`接続状態: ${state}\n`),
});

/** 接続を閉じ、収集件数と保存先を報告して終了する */
function finish(): void {
  client.disconnect();
  process.stdout.write(`収集を終了しました: ${collectedCount} 件 → ${outputPath}\n`);
  process.exit(0);
}

process.on("SIGINT", finish);
if (durationMinutes !== null) {
  setTimeout(finish, durationMinutes * MS_PER_MINUTE);
}

process.stdout.write(`#${channel} のチャットを収集します(保存先: ${outputPath})\n`);
client.connect(channel);
