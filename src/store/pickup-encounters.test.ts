/**
 * `pickup-encounters.ts`(Pick up の既出管理。issue #108)のテスト。
 *
 * 自動Pick upは同じ定型表現がチャットに流れるたびに毎回表示するため、表現キーごとの
 * 遭遇記録を localStorage に持ち、最終表示からクールダウン期間内の再表示を決定的に抑制する。
 * 検証項目:
 * - 初回遭遇は表示し、遭遇記録(遭遇回数・最終表示日時・最終表示メッセージID)を保存する
 * - クールダウン内の別メッセージでの再遭遇は抑制する(遭遇回数だけ加算する)
 * - クールダウン経過後の再遭遇は再び表示する
 * - 同一メッセージIDからの再抽出(言語設定変更等によるパイプライン再起動)は抑制しない
 * - 語形変化("picked up" / "pick up")は同一の表現キーとして扱う
 * - localStorage への永続化・破損データの扱い・エントリ数上限の整理
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTermExpressionKey } from "@/lib/ai/pickup-ordinary-filter";
import type { PickupTerm } from "@/lib/ai/schemas";
import {
  KNOWN_REDISPLAY_BASE_MS,
  KNOWN_REDISPLAY_MAX_MS,
  MAX_PICKUP_ENCOUNTER_ENTRIES,
  MAX_SHOWN_MESSAGE_IDS_PER_ENTRY,
  PICKUP_ENCOUNTER_COOLDOWN_MS,
  PICKUP_ENCOUNTER_STORAGE_KEY,
  markPickupTermKnown,
  recordPickupMeaningChecked,
  resetPickupEncountersForTests,
  suppressRecentPickupTerms,
} from "./pickup-encounters";

/** テストデータ組み立てヘルパー。意味の文字列は抑制判定に影響しない */
function terms(...termTexts: string[]): PickupTerm[] {
  return termTexts.map((term) => ({ term, meaning: "テスト用の意味" }));
}

/** 抑制適用後に残った語句だけを取り出すヘルパー */
function surviving(termTexts: string[], messageId: string): string[] {
  return suppressRecentPickupTerms(terms(...termTexts), messageId).map((item) => item.term);
}

/** 保存されている遭遇記録1件ぶんの形(version 2) */
interface StoredRecord {
  count: number;
  lastShownAt: number;
  shownMessageIds: string[];
  knownCount: number;
  lastKnownAt: number | null;
  meaningCheckedCount: number;
}

/** localStorage に保存された遭遇記録を読み出すヘルパー */
function storedEntries(): Record<string, StoredRecord> {
  const raw = window.localStorage.getItem(PICKUP_ENCOUNTER_STORAGE_KEY);
  if (raw === null) throw new Error("遭遇記録が localStorage に保存されていません");
  return (JSON.parse(raw) as { entries: Record<string, StoredRecord> }).entries;
}

/** 保存された遭遇記録から、唯一のエントリを取り出すヘルパー(エントリが1件の前提で使う) */
function soleStoredRecord(): StoredRecord {
  const entries = storedEntries();
  const keys = Object.keys(entries);
  if (keys.length !== 1) throw new Error(`エントリが1件ではありません(${String(keys.length)}件)`);
  return entries[keys[0]];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-04T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  resetPickupEncountersForTests();
});

describe("suppressRecentPickupTerms", () => {
  it("初回遭遇の表現は表示し、遭遇回数1・最終表示日時・表示したメッセージIDを記録する", () => {
    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);

    expect(soleStoredRecord()).toEqual({
      count: 1,
      lastShownAt: Date.now(),
      shownMessageIds: ["msg-1"],
      knownCount: 0,
      lastKnownAt: null,
      meaningCheckedCount: 0,
    });
  });

  it("最終表示からクールダウン内に別メッセージで再遭遇した表現は抑制し、遭遇回数だけ加算する", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS - 1);

    expect(surviving(["even though"], "msg-2")).toEqual([]);

    // 抑制時は遭遇回数だけ加算し、最終表示日時・表示したメッセージIDは更新しない(表示していないため)
    const record = soleStoredRecord();
    expect(record.count).toBe(2);
    expect(record.shownMessageIds).toEqual(["msg-1"]);
  });

  it("最終表示からクールダウンが経過した表現は再び表示し、最終表示日時を更新して表示したメッセージIDを追記する", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS);

    expect(surviving(["even though"], "msg-2")).toEqual(["even though"]);

    expect(soleStoredRecord()).toEqual({
      count: 2,
      lastShownAt: Date.now(),
      shownMessageIds: ["msg-1", "msg-2"],
      knownCount: 0,
      lastKnownAt: null,
      meaningCheckedCount: 0,
    });
  });

  it("表示済みと同じメッセージIDからの再遭遇(パイプライン再起動による再抽出)は抑制せず、記録も変えない", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(1000);

    // 言語設定変更などでパイプラインが再起動すると同じ発言が再抽出される。
    // 表示済みの表現が再生成で消えないよう、同じ遭遇の再表示として扱う
    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);

    expect(soleStoredRecord()).toEqual({
      count: 1,
      lastShownAt: Date.now() - 1000,
      shownMessageIds: ["msg-1"],
      knownCount: 0,
      lastKnownAt: null,
      meaningCheckedCount: 0,
    });
  });

  it("クールダウンを挟んで複数の発言で表示した表現は、どの発言の再抽出(パイプライン再起動)でも抑制しない", () => {
    // msg-1 で表示 → クールダウン経過後に msg-2 でも表示(CodeRabbit レビュー指摘の回帰テスト)
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS);
    surviving(["even though"], "msg-2");

    // パイプライン再起動で両方の発言が再抽出される。最新の msg-2 だけでなく msg-1 側も表示を維持する
    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);
    expect(surviving(["even though"], "msg-2")).toEqual(["even though"]);
  });

  it("表示したメッセージIDの保持数には上限があり、古いIDから追い出す", () => {
    // 上限+1回、クールダウンを挟みながら別々の発言で表示する
    for (let i = 0; i <= MAX_SHOWN_MESSAGE_IDS_PER_ENTRY; i += 1) {
      surviving(["even though"], `msg-${String(i)}`);
      vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS);
    }

    const entries = storedEntries();
    const record = entries[Object.keys(entries)[0]];
    expect(record.shownMessageIds).toHaveLength(MAX_SHOWN_MESSAGE_IDS_PER_ENTRY);
    // 最初の msg-0 は追い出され、以降の再抽出では(クールダウン経過後のため)通常規則で表示される
    expect(record.shownMessageIds).not.toContain("msg-0");
    expect(record.shownMessageIds).toContain(`msg-${String(MAX_SHOWN_MESSAGE_IDS_PER_ENTRY)}`);
  });

  it("語形変化した表現(picked up / pick up)は同一の表現キーとして抑制する", () => {
    surviving(["picked up"], "msg-1");

    expect(surviving(["pick up"], "msg-2")).toEqual([]);
  });

  it("抑制は該当する表現だけに作用し、同じメッセージの他の表現は表示する", () => {
    surviving(["even though"], "msg-1");

    expect(surviving(["even though", "malding"], "msg-2")).toEqual(["malding"]);
  });

  it("保存済みの遭遇記録を localStorage から復元して抑制する(ページ再読み込み相当)", () => {
    surviving(["even though"], "msg-1");

    // メモリ上の記録を破棄しても localStorage から復元されて抑制が維持される
    resetPickupEncountersForTests();

    expect(surviving(["even though"], "msg-2")).toEqual([]);
  });

  it("localStorage の保存データが壊れている場合は空の記録として扱い、抑制せずに表示する", () => {
    window.localStorage.setItem(PICKUP_ENCOUNTER_STORAGE_KEY, "壊れたJSON{");

    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);
  });

  it("エントリ数が上限を超えたら、最終表示日時が古いエントリから削除する", () => {
    // 表現キーの正規化(数字の除去・語尾の変化)で衝突しないよう、番号を英字だけの綴りに変換する
    // (使用する英字は s / d / g を含まず、ステム処理の接尾辞規則に一致しない)
    const uniqueTerm = (index: number): string =>
      `word${String(index).replace(/\d/g, (digit) => "klmnopqrtu"[Number(digit)])}`;

    // 上限ちょうどまで、1件ずつ時刻をずらしながら記録する(最初の1件が最も古い)
    for (let i = 0; i < MAX_PICKUP_ENCOUNTER_ENTRIES; i += 1) {
      surviving([uniqueTerm(i)], `msg-${String(i)}`);
      vi.advanceTimersByTime(1);
    }
    expect(Object.keys(storedEntries())).toHaveLength(MAX_PICKUP_ENCOUNTER_ENTRIES);

    // 1件追加すると上限を超えるため、最も古い最初のエントリ(uniqueTerm(0))が削除される
    surviving(["newest expression"], "msg-new");

    const entries = storedEntries();
    expect(Object.keys(entries)).toHaveLength(MAX_PICKUP_ENCOUNTER_ENTRIES);
    expect(entries[buildTermExpressionKey(uniqueTerm(0))]).toBeUndefined();
    expect(entries[buildTermExpressionKey(uniqueTerm(1))]).toBeDefined();
  });
});

describe("markPickupTermKnown(「知っている」マーク。issue #110)", () => {
  it("マークすると knownCount と lastKnownAt を記録する(遭遇記録の他のフィールドは変えない)", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(1000);

    markPickupTermKnown("even though");

    expect(soleStoredRecord()).toEqual({
      count: 1,
      lastShownAt: Date.now() - 1000,
      shownMessageIds: ["msg-1"],
      knownCount: 1,
      lastKnownAt: Date.now(),
      meaningCheckedCount: 0,
    });
  });

  it("マーク済みの表現は、クールダウンを過ぎていても再表示間隔(1回目は7日)内なら抑制し、遭遇回数だけ加算する", () => {
    surviving(["even though"], "msg-1");
    markPickupTermKnown("even though");
    // クールダウン(30分)はとうに過ぎているが、再表示間隔(7日)内
    vi.advanceTimersByTime(KNOWN_REDISPLAY_BASE_MS - 1);

    expect(surviving(["even though"], "msg-2")).toEqual([]);
    expect(soleStoredRecord().count).toBe(2);
  });

  it("マークから再表示間隔が経過した表現は再び表示する(忘却チェックの機会)", () => {
    surviving(["even though"], "msg-1");
    markPickupTermKnown("even though");
    vi.advanceTimersByTime(KNOWN_REDISPLAY_BASE_MS);

    expect(surviving(["even though"], "msg-2")).toEqual(["even though"]);
  });

  it("再表示間隔はマーク回数で倍増する(2回目のマーク後は14日)", () => {
    surviving(["even though"], "msg-1");
    markPickupTermKnown("even though");
    vi.advanceTimersByTime(KNOWN_REDISPLAY_BASE_MS);
    surviving(["even though"], "msg-2");
    markPickupTermKnown("even though");

    // 2回目のマークから7日(1回目の間隔)では、まだ14日の間隔内のため抑制する
    vi.advanceTimersByTime(KNOWN_REDISPLAY_BASE_MS);
    expect(surviving(["even though"], "msg-3")).toEqual([]);

    // 2回目のマークから14日経過で再表示する
    vi.advanceTimersByTime(KNOWN_REDISPLAY_BASE_MS);
    expect(surviving(["even though"], "msg-4")).toEqual(["even though"]);
  });

  it("再表示間隔には上限があり、何度マークしても上限を超えて延びない", () => {
    surviving(["even though"], "msg-1");
    // 上限(KNOWN_REDISPLAY_MAX_MS)を大きく超える回数マークする
    for (let i = 0; i < 20; i += 1) {
      markPickupTermKnown("even though");
    }
    vi.advanceTimersByTime(KNOWN_REDISPLAY_MAX_MS);

    expect(surviving(["even though"], "msg-2")).toEqual(["even though"]);
  });

  it("マーク済みでも、表示済みメッセージIDからの再抽出(パイプライン再起動)は抑制しない(画面の非表示は hidden-pickups が担う)", () => {
    surviving(["even though"], "msg-1");
    markPickupTermKnown("even though");
    vi.advanceTimersByTime(1000);

    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);
  });

  it("語形変化した表現(picked up / pick up)へのマークも同一の表現キーに記録する", () => {
    surviving(["picked up"], "msg-1");
    markPickupTermKnown("pick up");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS);

    // クールダウンは過ぎたが再表示間隔(7日)内のため抑制される
    expect(surviving(["picked up"], "msg-2")).toEqual([]);
  });

  it("遭遇記録が無い表現へのマークは、自動表示の記録が空のエントリを作って記録する", () => {
    markPickupTermKnown("even though");

    expect(soleStoredRecord()).toEqual({
      count: 0,
      lastShownAt: 0,
      shownMessageIds: [],
      knownCount: 1,
      lastKnownAt: Date.now(),
      meaningCheckedCount: 0,
    });
  });
});

describe("recordPickupMeaningChecked(意味を確認した回数の記録。issue #110)", () => {
  it("記録すると meaningCheckedCount を加算する(抑制の挙動には影響しない)", () => {
    surviving(["even though"], "msg-1");

    recordPickupMeaningChecked("even though");
    recordPickupMeaningChecked("even though");

    const record = soleStoredRecord();
    expect(record.meaningCheckedCount).toBe(2);
    expect(record.count).toBe(1);
    expect(record.lastKnownAt).toBeNull();
  });

  it("遭遇記録が無い表現(手動Pick upだけの表現)にも、自動表示の記録が空のエントリを作って記録する", () => {
    recordPickupMeaningChecked("hold my beer");

    expect(soleStoredRecord()).toEqual({
      count: 0,
      lastShownAt: 0,
      shownMessageIds: [],
      knownCount: 0,
      lastKnownAt: null,
      meaningCheckedCount: 1,
    });
  });
});

describe("保存形式の移行(version 1 → 2)", () => {
  it("version 1 の保存データは既存の遭遇記録を保持したまま新フィールドの既定値を補って読み込む", () => {
    // Phase 1(PR #109)が保存した version 1 形式
    window.localStorage.setItem(
      PICKUP_ENCOUNTER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        entries: { "even though": { count: 3, lastShownAt: Date.now() - 1000, shownMessageIds: ["msg-old"] } },
      }),
    );

    // クールダウン内のため v1 の記録に基づいて抑制される(記録が引き継がれている証拠)
    expect(surviving(["even though"], "msg-new")).toEqual([]);

    // 書き戻しは version 2 形式で、新フィールドは既定値が補われている
    const raw = window.localStorage.getItem(PICKUP_ENCOUNTER_STORAGE_KEY);
    expect(raw).not.toBeNull();
    expect((JSON.parse(raw as string) as { version: number }).version).toBe(2);
    expect(storedEntries()["even though"]).toEqual({
      count: 4,
      lastShownAt: Date.now() - 1000,
      shownMessageIds: ["msg-old"],
      knownCount: 0,
      lastKnownAt: null,
      meaningCheckedCount: 0,
    });
  });
});
