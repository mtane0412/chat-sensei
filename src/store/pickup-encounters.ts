/**
 * Pick up の既出管理(issue #108。ユーザー辞書構想 #107 の Phase 1)。
 *
 * 自動Pick upは同じ定型表現("even though" など)がチャットに流れるたびに毎回抽出・表示するため、
 * 表現キーごとの遭遇記録を持ち、最終表示からクールダウン期間内の再表示を決定的に抑制する。
 *
 * - キー: `lib/ai/pickup-ordinary-filter.ts` の `buildTermExpressionKey`(`stemForMatch` による
 *   レンマ正規化キー)。語形変化("picked up" / "pick up")を同一表現として扱う
 * - 抑制規則: 最終表示からクールダウン内の再遭遇は表示しない(遭遇回数だけ加算する)。
 *   ただし最終表示と同じメッセージIDからの再遭遇は「パイプライン再起動による同じ発言の再抽出」
 *   (`hidden-pickups.ts` に記載の再生成問題)なので、同じ遭遇の再表示として抑制せず記録も変えない
 * - 適用範囲: 自動Pick up(`pickups.ts`)の順方向・逆方向のみ。手動Pick up(`manual-pickups.ts`)は
 *   ユーザーが明示的に選択した操作のため対象外。翻訳列にも影響しない
 * - 永続化: localStorage(`lib/settings.ts` と同じパターン)。学習状態はユーザーに属するため
 *   チャンネルをまたいで共有する。Phase 2(習熟状態)・Phase 3(SRS)でのスキーマ拡張に備えて
 *   保存形式にバージョンを持たせる。保存データが壊れている場合は空の記録から再開する
 *   (抑制が一時的に働かなくなるだけで表示機能は損なわれず、壊れた学習記録の復元は不可能なため)
 * - この層は完全に決定的(LLM 非依存)
 */
import { buildTermExpressionKey } from "@/lib/ai/pickup-ordinary-filter";
import type { PickupTerm } from "@/lib/ai/schemas";
import { z } from "zod";

export const PICKUP_ENCOUNTER_STORAGE_KEY = "chat-sensei:pickup-encounters";

/**
 * 再表示を抑制するクールダウン期間。抑制しすぎると学習機会を失うため(issue #107 の留意点)、
 * 控えめな既定値として30分から始める(1配信セッション中に同じ定型表現が2回以上出れば再表示される)
 */
export const PICKUP_ENCOUNTER_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 保持する遭遇記録の上限。超過時は最終表示日時が古いエントリから削除する。
 * 1エントリはおおむね100バイト弱のため、2000件でも localStorage の容量(一般に5MB)を圧迫しない
 */
export const MAX_PICKUP_ENCOUNTER_ENTRIES = 2000;

/** 表現キー1件ぶんの遭遇記録 */
const encounterRecordSchema = z.object({
  /** 遭遇回数(抑制した遭遇も含む)。Phase 2 以降で習熟度の入力に使う */
  count: z.number(),
  /** 最終表示日時(エポックミリ秒)。抑制した遭遇では更新しない */
  lastShownAt: z.number(),
  /** 最終表示したメッセージID。パイプライン再起動による同じ発言の再抽出を抑制対象から外すために持つ */
  lastShownMessageId: z.string(),
});

/** 保存形式。Phase 2(習熟状態)・Phase 3(SRS)での拡張に備えて version を持つ */
const storedEncountersSchema = z.object({
  version: z.literal(1),
  entries: z.record(z.string(), encounterRecordSchema),
});

type EncounterRecord = z.infer<typeof encounterRecordSchema>;

/**
 * メモリ上の遭遇記録。初回利用時に localStorage から復元し(`ensureLoaded`)、以後は
 * このマップを正本として更新のたびに書き戻す。null は未復元を表す
 */
let encounters: Map<string, EncounterRecord> | null = null;

/** localStorage から遭遇記録を復元する。無い場合・壊れている場合は空の記録から再開する */
function ensureLoaded(): Map<string, EncounterRecord> {
  if (encounters !== null) return encounters;
  encounters = new Map();
  const raw = window.localStorage.getItem(PICKUP_ENCOUNTER_STORAGE_KEY);
  if (raw === null) return encounters;
  try {
    const stored = storedEncountersSchema.parse(JSON.parse(raw));
    encounters = new Map(Object.entries(stored.entries));
  } catch {
    // 壊れた記録は復元できず、失っても抑制が一時的に働かなくなるだけのため空から再開する(冒頭コメント参照)
  }
  return encounters;
}

/** 遭遇記録を localStorage に書き戻す。上限超過時は最終表示日時が古いエントリから削除する */
function persist(loaded: Map<string, EncounterRecord>): void {
  if (loaded.size > MAX_PICKUP_ENCOUNTER_ENTRIES) {
    const excess = [...loaded.entries()]
      .sort(([, a], [, b]) => a.lastShownAt - b.lastShownAt)
      .slice(0, loaded.size - MAX_PICKUP_ENCOUNTER_ENTRIES);
    for (const [key] of excess) loaded.delete(key);
  }
  window.localStorage.setItem(
    PICKUP_ENCOUNTER_STORAGE_KEY,
    JSON.stringify({ version: 1, entries: Object.fromEntries(loaded) }),
  );
}

/**
 * 抽出結果から、最終表示からクールダウン内の既出表現を落とし、遭遇記録を更新する。
 * `pickups.ts` の決定的後段フィルタの後(表示リストへの追加前)に順方向・逆方向の両方で呼ぶ。
 *
 * @param terms 決定的フィルタ適用後の抽出結果
 * @param messageId 抽出元のメッセージID(逆方向では訳文の元になった発言のID)
 * @returns 表示する語句(抑制した語句を除いたもの)
 */
export function suppressRecentPickupTerms(terms: PickupTerm[], messageId: string): PickupTerm[] {
  const loaded = ensureLoaded();
  const now = Date.now();
  const shown: PickupTerm[] = [];
  for (const item of terms) {
    const key = buildTermExpressionKey(item.term);
    const record = loaded.get(key);
    if (record === undefined) {
      // 初回遭遇: 表示して記録を作る
      loaded.set(key, { count: 1, lastShownAt: now, lastShownMessageId: messageId });
      shown.push(item);
    } else if (record.lastShownMessageId === messageId) {
      // 最終表示と同じ発言からの再抽出(パイプライン再起動): 同じ遭遇の再表示として扱い、記録は変えない
      shown.push(item);
    } else if (now - record.lastShownAt < PICKUP_ENCOUNTER_COOLDOWN_MS) {
      // クールダウン内の再遭遇: 抑制する。遭遇回数だけ加算し、最終表示日時・メッセージIDは表示していないので変えない
      loaded.set(key, { ...record, count: record.count + 1 });
    } else {
      // クールダウン経過後の再遭遇: 再び表示する
      loaded.set(key, { count: record.count + 1, lastShownAt: now, lastShownMessageId: messageId });
      shown.push(item);
    }
  }
  persist(loaded);
  return shown;
}

/** テスト専用: メモリ上の記録を破棄し、次回利用時に localStorage から復元し直す */
export function resetPickupEncountersForTests(): void {
  encounters = null;
}
