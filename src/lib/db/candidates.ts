/**
 * 自動抽出パイプライン(Phase 4)が生成した「カード候補」(`Candidate`)のCRUDと、
 * 採用(単語帳への保存)・却下(削除)を行うモジュール。
 *
 * 自動抽出は誤判定を含みうるため `cards` へ直接保存せず、いったん `candidates` に
 * 貯め、利用者が `/deck` のレビューUIで採用/却下してから初めて単語帳(`cards`)に入る。
 * 採用時のSRS初期化ロジックは `cards.ts` の `createCard` をそのまま再利用し、重複させない。
 */
import { liveQuery } from "dexie";
import type { Card, Candidate } from "./schema";
import { db } from "./schema";
import { createCard } from "./cards";

/** 候補作成時に渡す入力(id・createdAtはこの関数側で採番・初期化する) */
export type NewCandidateInput = Omit<Candidate, "id" | "createdAt">;

/** 候補を作成し、DBに保存したうえで保存内容(採番されたid・createdAt付き)を返す */
export async function createCandidate(input: NewCandidateInput): Promise<Candidate> {
  const candidate: Candidate = { ...input, createdAt: Date.now() };
  const id = await db.candidates.add(candidate);
  return { ...candidate, id };
}

/** 全候補を作成日時が新しい順に返す */
export async function listCandidates(): Promise<Candidate[]> {
  return db.candidates.orderBy("createdAt").reverse().toArray();
}

/**
 * 候補を採用する: 単語帳(cards)へ保存し、候補自体を削除する。
 * 「保存できたが候補が消えずに残る」といった中途半端な状態を避けるため、
 * ひとつのDexieトランザクションとして不可分に実行する。
 */
export async function acceptCandidate(id: number): Promise<Card> {
  return db.transaction("rw", db.candidates, db.cards, async () => {
    const candidate = await db.candidates.get(id);
    if (!candidate) {
      throw new Error(`候補が見つかりません(id: ${id})`);
    }

    const card = await createCard({
      term: candidate.term,
      kind: candidate.kind,
      meaning: candidate.meaning,
      note: candidate.note,
      sourceMessageText: candidate.sourceMessageText,
      sourceChannel: candidate.sourceChannel,
      sourceAuthor: candidate.sourceAuthor,
      targetLang: candidate.targetLang,
      explainLang: candidate.explainLang,
      tags: candidate.tags,
    });
    await db.candidates.delete(id);
    return card;
  });
}

/** 候補を却下する: 単語帳には保存せず削除する */
export async function rejectCandidate(id: number): Promise<void> {
  await db.candidates.delete(id);
}

/**
 * 候補テーブルの変更をリアルタイムに購読する。
 * 自動抽出パイプラインが候補を追加した瞬間や、採用/却下で候補が減った瞬間に
 * `onData` が最新の一覧(作成日時が古い順=レビューすべき順)で呼ばれる。
 * 返り値の関数を呼ぶと購読を解除する。
 */
export function subscribeToCandidates(
  onData: (candidates: Candidate[]) => void,
  onError?: (error: unknown) => void,
): () => void {
  const subscription = liveQuery(() => db.candidates.orderBy("createdAt").toArray()).subscribe({
    next: onData,
    error: (error: unknown) => onError?.(error),
  });
  return () => subscription.unsubscribe();
}
