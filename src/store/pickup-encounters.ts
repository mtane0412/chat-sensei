/**
 * Pick up の既出管理と習熟状態(issue #108 / #110。ユーザー辞書構想 #107 の Phase 1・2)。
 *
 * 自動Pick upは同じ定型表現("even though" など)がチャットに流れるたびに毎回抽出・表示するため、
 * 表現キーごとの遭遇記録・習熟状態を持ち、再表示を決定的に抑制する。
 *
 * - キー: `lib/ai/pickup-ordinary-filter.ts` の `buildTermExpressionKey`(`stemForMatch` による
 *   レンマ正規化キー)。語形変化("picked up" / "pick up")を同一表現として扱う
 * - 抑制規則(判定順):
 *   1. 表示済みのメッセージID(上限付きで保持)からの再遭遇は「パイプライン再起動による同じ発言の
 *      再抽出」(`hidden-pickups.ts` に記載の再生成問題)なので、同じ遭遇の再表示として抑制せず記録も変えない
 *   2. 「知っている」マーク済みの表現は、最終マークから再表示間隔(マーク回数で倍増、上限あり)内は
 *      表示しない(遭遇回数だけ加算する)。恒久非表示にはせず、間隔が明けたら忘却チェックの機会として
 *      再表示する。この倍増規則は Phase 3 で FSRS / SM-2 による復習期日計算に置き換える前提の暫定規則
 *   3. 最終表示からクールダウン内の再遭遇は表示しない(遭遇回数だけ加算する)
 * - 習熟状態の記録(issue #110): 「知っている」マーク(`markPickupTermKnown`。UIの✓ボタンから呼ぶ)と、
 *   意味を確認した回数(`recordPickupMeaningChecked`。手動Pick upの意味生成完了時に呼ぶ)
 * - 適用範囲: 抑制は自動Pick up(`pickups.ts`)の順方向・逆方向のみ。手動Pick up(`manual-pickups.ts`)は
 *   ユーザーが明示的に選択した操作のため抑制対象外(記録のみ行う)。翻訳列にも影響しない
 * - 永続化: localStorage(`lib/settings.ts` と同じパターン)。学習状態はユーザーに属するため
 *   チャンネルをまたいで共有する。保存形式はバージョンを持ち、version 1(Phase 1)のデータは
 *   既定値を補って明示的に移行する。保存データが壊れている場合は空の記録から再開する
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

/**
 * 表現キー1件あたりで保持する、表示したメッセージIDの上限。パイプライン再起動時に再抽出されるのは
 * 画面に表示中の発言だけのため、同じ表現を表示した直近の発言をこの件数まで覚えていれば足りる。
 * 追い出された古いIDの発言が再抽出された場合は通常のクールダウン規則で判定される(最終表示から
 * クールダウンが経過していれば表示される)
 */
export const MAX_SHOWN_MESSAGE_IDS_PER_ENTRY = 10;

/**
 * 「知っている」マーク後の再表示間隔の基準値(1回目のマーク後は7日)。マーク回数ごとに倍増する
 * (7日 → 14日 → 28日…)。恒久非表示にすると忘却に気付けないため、間隔反復学習的に間隔を空けて
 * 再表示する(issue #110。Phase 3 で FSRS / SM-2 による復習期日計算に置き換える前提の暫定規則)
 */
export const KNOWN_REDISPLAY_BASE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 「知っている」マーク後の再表示間隔の上限(56日 = 基準値の8倍)。何度マークしても
 * これ以上は延びない。Phase 3 の復習期日計算の導入までの暫定的な安全弁
 */
export const KNOWN_REDISPLAY_MAX_MS = 56 * 24 * 60 * 60 * 1000;

/** 表現キー1件ぶんの遭遇記録・習熟状態(version 2) */
const encounterRecordSchema = z.object({
  /** 遭遇回数(抑制した遭遇も含む)。Phase 3(SRS)で習熟度の入力に使う */
  count: z.number(),
  /** 最終表示日時(エポックミリ秒)。抑制した遭遇では更新しない。自動表示の記録が無い場合は 0 */
  lastShownAt: z.number(),
  /**
   * 表示したメッセージID(古い順、`MAX_SHOWN_MESSAGE_IDS_PER_ENTRY` 件まで)。
   * パイプライン再起動による同じ発言の再抽出を抑制対象から外すために持つ
   */
  shownMessageIds: z.array(z.string()),
  /** 「知っている」マークを押した回数(issue #110)。再表示間隔の倍増と Phase 3 の入力に使う */
  knownCount: z.number(),
  /** 最後に「知っている」マークを押した日時(エポックミリ秒)。未マークは null */
  lastKnownAt: z.number().nullable(),
  /** 意味を確認した(手動Pick upで意味を調べた)回数(issue #110)。Phase 3 の入力に使う */
  meaningCheckedCount: z.number(),
});

/** 現行の保存形式(version 2)。Phase 3(SRS)での拡張に備えて version を持つ */
const storedEncountersSchema = z.object({
  version: z.literal(2),
  entries: z.record(z.string(), encounterRecordSchema),
});

/** Phase 1(PR #109)が保存していた旧形式(version 1)。読み込み時に既定値を補って移行する */
const storedEncountersV1Schema = z.object({
  version: z.literal(1),
  entries: z.record(
    z.string(),
    z.object({ count: z.number(), lastShownAt: z.number(), shownMessageIds: z.array(z.string()) }),
  ),
});

type EncounterRecord = z.infer<typeof encounterRecordSchema>;

/** version 1 の記録に Phase 2 で追加したフィールドの既定値。移行と新規エントリの作成で共通に使う */
const RECORD_V2_DEFAULTS = { knownCount: 0, lastKnownAt: null, meaningCheckedCount: 0 } as const;

/**
 * メモリ上の遭遇記録。初回利用時に localStorage から復元し(`ensureLoaded`)、以後は
 * このマップを正本として更新のたびに書き戻す。null は未復元を表す
 */
let encounters: Map<string, EncounterRecord> | null = null;

/**
 * 保存データ(JSON パース済み)を現行形式の記録へ変換する。version 1 の記録は Phase 2 で
 * 追加したフィールドの既定値を補って明示的に移行する。どの形式にも合わなければ例外を投げる
 */
function parseStoredEncounters(raw: unknown): Map<string, EncounterRecord> {
  const current = storedEncountersSchema.safeParse(raw);
  if (current.success) return new Map(Object.entries(current.data.entries));
  const v1 = storedEncountersV1Schema.parse(raw);
  return new Map(Object.entries(v1.entries).map(([key, record]) => [key, { ...record, ...RECORD_V2_DEFAULTS }]));
}

/** localStorage から遭遇記録を復元する。無い場合・壊れている場合は空の記録から再開する */
function ensureLoaded(): Map<string, EncounterRecord> {
  if (encounters !== null) return encounters;
  encounters = new Map();
  const raw = window.localStorage.getItem(PICKUP_ENCOUNTER_STORAGE_KEY);
  if (raw === null) return encounters;
  try {
    encounters = parseStoredEncounters(JSON.parse(raw));
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
    JSON.stringify({ version: 2, entries: Object.fromEntries(loaded) }),
  );
}

/**
 * 「知っている」マークからの再表示間隔。マーク回数ごとに基準値(7日)を倍増し、上限で頭打ちにする。
 * `knownCount` が 0(未マーク)の場合は呼ばない前提(呼び出し側で lastKnownAt の null を先に判定する)
 */
function knownRedisplayIntervalMs(knownCount: number): number {
  return Math.min(KNOWN_REDISPLAY_BASE_MS * 2 ** (knownCount - 1), KNOWN_REDISPLAY_MAX_MS);
}

/**
 * 表現キーの記録を取得し、無ければ「自動表示の記録が空」のエントリを作って返す。
 * `markPickupTermKnown` / `recordPickupMeaningChecked` は表示済み・手動選択済みの語句から呼ばれるため
 * 通常は記録が存在するが、上限整理(`persist`)で削除された直後などに欠けていても失敗させない
 */
function ensureRecord(loaded: Map<string, EncounterRecord>, key: string): EncounterRecord {
  const existing = loaded.get(key);
  if (existing !== undefined) return existing;
  const created: EncounterRecord = { count: 0, lastShownAt: 0, shownMessageIds: [], ...RECORD_V2_DEFAULTS };
  loaded.set(key, created);
  return created;
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
      loaded.set(key, { count: 1, lastShownAt: now, shownMessageIds: [messageId], ...RECORD_V2_DEFAULTS });
      shown.push(item);
    } else if (record.shownMessageIds.includes(messageId)) {
      // 表示済みの発言からの再抽出(パイプライン再起動): 同じ遭遇の再表示として扱い、記録は変えない。
      // マーク済みの表現でも同様に返す(押した行の画面上の非表示は hidden-pickups が担う)
      shown.push(item);
    } else if (
      (record.lastKnownAt !== null && now - record.lastKnownAt < knownRedisplayIntervalMs(record.knownCount)) ||
      now - record.lastShownAt < PICKUP_ENCOUNTER_COOLDOWN_MS
    ) {
      // 「知っている」マークからの再表示間隔内、またはクールダウン内の再遭遇: 抑制する。
      // 遭遇回数だけ加算し、最終表示日時・表示したメッセージIDは表示していないので変えない
      loaded.set(key, { ...record, count: record.count + 1 });
    } else {
      // 抑制期間を過ぎた再遭遇: 再び表示し、表示したメッセージIDを上限付きで追記する
      loaded.set(key, {
        ...record,
        count: record.count + 1,
        lastShownAt: now,
        shownMessageIds: [...record.shownMessageIds, messageId].slice(-MAX_SHOWN_MESSAGE_IDS_PER_ENTRY),
      });
      shown.push(item);
    }
  }
  persist(loaded);
  return shown;
}

/**
 * 表現に「知っている」マークを付ける(issue #110)。マーク回数と最終マーク日時を記録し、
 * 以後の自動Pick upを再表示間隔(マーク回数で倍増、上限あり)のあいだ抑制する。
 * Pick up列の✓ボタン(`page.tsx`)から呼ぶ。押した行の画面上の非表示は呼び出し側が
 * `hidden-pickups.ts` で行う(この関数は学習状態の記録と以後の抑制だけを担う)
 */
export function markPickupTermKnown(term: string): void {
  const loaded = ensureLoaded();
  const record = ensureRecord(loaded, buildTermExpressionKey(term));
  loaded.set(buildTermExpressionKey(term), {
    ...record,
    knownCount: record.knownCount + 1,
    lastKnownAt: Date.now(),
  });
  persist(loaded);
}

/**
 * 表現の意味を確認した(手動Pick upで意味を調べた)ことを記録する(issue #110)。
 * 手動Pick up(`manual-pickups.ts`)の意味生成が完了した時点で呼ぶ。抑制の挙動には影響せず、
 * Phase 3(SRS)の習熟度計算の入力として回数だけを蓄積する
 */
export function recordPickupMeaningChecked(term: string): void {
  const loaded = ensureLoaded();
  const record = ensureRecord(loaded, buildTermExpressionKey(term));
  loaded.set(buildTermExpressionKey(term), {
    ...record,
    meaningCheckedCount: record.meaningCheckedCount + 1,
  });
  persist(loaded);
}

/** テスト専用: メモリ上の記録を破棄し、次回利用時に localStorage から復元し直す */
export function resetPickupEncountersForTests(): void {
  encounters = null;
}
