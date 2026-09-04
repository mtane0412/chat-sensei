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
  MAX_PICKUP_ENCOUNTER_ENTRIES,
  MAX_SHOWN_MESSAGE_IDS_PER_ENTRY,
  PICKUP_ENCOUNTER_COOLDOWN_MS,
  PICKUP_ENCOUNTER_STORAGE_KEY,
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

/** localStorage に保存された遭遇記録を読み出すヘルパー */
function storedEntries(): Record<string, { count: number; lastShownAt: number; shownMessageIds: string[] }> {
  const raw = window.localStorage.getItem(PICKUP_ENCOUNTER_STORAGE_KEY);
  if (raw === null) throw new Error("遭遇記録が localStorage に保存されていません");
  return (JSON.parse(raw) as { entries: Record<string, { count: number; lastShownAt: number; shownMessageIds: string[] }> })
    .entries;
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

    const entries = storedEntries();
    const keys = Object.keys(entries);
    expect(keys).toHaveLength(1);
    expect(entries[keys[0]]).toEqual({
      count: 1,
      lastShownAt: Date.now(),
      shownMessageIds: ["msg-1"],
    });
  });

  it("最終表示からクールダウン内に別メッセージで再遭遇した表現は抑制し、遭遇回数だけ加算する", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS - 1);

    expect(surviving(["even though"], "msg-2")).toEqual([]);

    // 抑制時は遭遇回数だけ加算し、最終表示日時・表示したメッセージIDは更新しない(表示していないため)
    const entries = storedEntries();
    const record = entries[Object.keys(entries)[0]];
    expect(record.count).toBe(2);
    expect(record.shownMessageIds).toEqual(["msg-1"]);
  });

  it("最終表示からクールダウンが経過した表現は再び表示し、最終表示日時を更新して表示したメッセージIDを追記する", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(PICKUP_ENCOUNTER_COOLDOWN_MS);

    expect(surviving(["even though"], "msg-2")).toEqual(["even though"]);

    const entries = storedEntries();
    const record = entries[Object.keys(entries)[0]];
    expect(record).toEqual({ count: 2, lastShownAt: Date.now(), shownMessageIds: ["msg-1", "msg-2"] });
  });

  it("表示済みと同じメッセージIDからの再遭遇(パイプライン再起動による再抽出)は抑制せず、記録も変えない", () => {
    surviving(["even though"], "msg-1");
    vi.advanceTimersByTime(1000);

    // 言語設定変更などでパイプラインが再起動すると同じ発言が再抽出される。
    // 表示済みの表現が再生成で消えないよう、同じ遭遇の再表示として扱う
    expect(surviving(["even though"], "msg-1")).toEqual(["even though"]);

    const entries = storedEntries();
    const record = entries[Object.keys(entries)[0]];
    expect(record).toEqual({
      count: 1,
      lastShownAt: Date.now() - 1000,
      shownMessageIds: ["msg-1"],
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
