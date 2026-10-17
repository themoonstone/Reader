import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { DraftInput } from "./contracts";
export const reviewTables = [
  "review_entries",
  "review_sessions",
  "review_cards",
  "review_records",
] as const;
export function recognitionSentence(data: DraftInput) {
  return (
    data.sourceType === "Writing" && data.eventKind !== "output_used"
      ? data.correctedSentence
      : data.correctedSentence || data.sentence
  ).trim();
}
export function createReviewTables(db: DatabaseSync) {
  db.exec(`
 CREATE TABLE review_entries(id TEXT PRIMARY KEY,expression_id TEXT NOT NULL UNIQUE REFERENCES expressions(id),state TEXT NOT NULL,pause_reason TEXT NOT NULL,stage INTEGER NOT NULL,eligible_after TEXT,first_presented_at TEXT,first_presented_local_date TEXT,first_presented_timezone TEXT,last_presented_at TEXT,last_reviewed_at TEXT,version INTEGER NOT NULL,last_pool_operation_id TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE review_sessions(id TEXT PRIMARY KEY,start_request_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL,budget_seconds INTEGER NOT NULL,card_limit INTEGER NOT NULL,new_limit INTEGER NOT NULL,active_elapsed_ms INTEGER NOT NULL,issued_count INTEGER NOT NULL,introduced_count INTEGER NOT NULL,current_card_id TEXT,policy_version TEXT NOT NULL,policy TEXT NOT NULL,version INTEGER NOT NULL,started_at TEXT NOT NULL,ended_at TEXT,end_reason TEXT NOT NULL,last_checkpoint_at TEXT NOT NULL);
 CREATE UNIQUE INDEX review_open_session ON review_sessions((1)) WHERE state!='ended';
 CREATE TABLE review_cards(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES review_sessions(id),entry_id TEXT NOT NULL REFERENCES review_entries(id),expression_id TEXT NOT NULL REFERENCES expressions(id),context_id TEXT NOT NULL REFERENCES contexts(id),issue_request_id TEXT NOT NULL UNIQUE,review_type TEXT NOT NULL,state TEXT NOT NULL,snapshot TEXT NOT NULL,expression_version INTEGER NOT NULL,context_version INTEGER NOT NULL,source_version INTEGER NOT NULL,entry_version INTEGER NOT NULL,is_first_presentation INTEGER NOT NULL,presented_local_date TEXT NOT NULL,presented_timezone TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,revealed_at TEXT,UNIQUE(session_id,expression_id));
 CREATE INDEX review_card_context ON review_cards(context_id,created_at);
 CREATE INDEX review_introductions ON review_cards(presented_local_date,is_first_presentation);
 CREATE TABLE review_records(id TEXT PRIMARY KEY,card_id TEXT NOT NULL UNIQUE REFERENCES review_cards(id),session_id TEXT NOT NULL REFERENCES review_sessions(id),entry_id TEXT NOT NULL REFERENCES review_entries(id),original_expression_id TEXT NOT NULL REFERENCES expressions(id),context_id TEXT NOT NULL REFERENCES contexts(id),review_type TEXT NOT NULL,result TEXT NOT NULL,reviewed_at TEXT NOT NULL,old_stage INTEGER NOT NULL,new_stage INTEGER NOT NULL,old_eligible_after TEXT,new_eligible_after TEXT NOT NULL,policy_version TEXT NOT NULL,snapshot TEXT NOT NULL);
 CREATE TABLE review_leases(session_id TEXT PRIMARY KEY REFERENCES review_sessions(id),owner_tab TEXT NOT NULL,token TEXT NOT NULL,version INTEGER NOT NULL,expires_at TEXT NOT NULL,process_id TEXT NOT NULL);
 PRAGMA user_version=3;
`);
}
const runtime = globalThis as unknown as { readwordsReviewProcess?: string };
export const reviewProcessId = () =>
  (runtime.readwordsReviewProcess ??= randomUUID());
export function restartReview(db: DatabaseSync, now: string) {
  db.prepare(
    "DELETE FROM review_leases WHERE process_id!=? OR expires_at<=?",
  ).run(reviewProcessId(), now);
  db.exec(
    "UPDATE review_sessions SET state='paused',version=version+1 WHERE state='running' AND NOT EXISTS(SELECT 1 FROM review_leases l WHERE l.session_id=review_sessions.id)",
  );
}
export function hasReviewMaterial(db: DatabaseSync, id: string) {
  const e = db
    .prepare("SELECT lifecycle,priority,meaning FROM expressions WHERE id=?")
    .get(id);
  if (
    !e ||
    e.lifecycle !== "active" ||
    !["P1", "P2"].includes(String(e.priority)) ||
    !e.meaning
  )
    return false;
  return db
    .prepare(
      "SELECT data FROM contexts WHERE expression_id=? AND lifecycle='active'",
    )
    .all(id)
    .some((row) => {
      const d = JSON.parse(String(row.data)) as DraftInput;
      return Boolean(d.meaning && recognitionSentence(d));
    });
}
/** Runs before the outer domain transaction commits: maintenance and auto-pause are atomic. */
export function reconcileReview(db: DatabaseSync, now: string) {
  for (const row of db
    .prepare("SELECT id,expression_id FROM review_entries WHERE state='active'")
    .all())
    if (!hasReviewMaterial(db, String(row.expression_id)))
      db.prepare(
        "UPDATE review_entries SET state='paused',pause_reason='material_unavailable',version=version+1,updated_at=? WHERE id=?",
      ).run(now, row.id!);
  db.exec(`UPDATE review_cards SET state='invalidated',version=version+1 WHERE state IN ('shown','revealed') AND session_id IN (SELECT id FROM review_sessions WHERE state!='ended') AND (
 NOT EXISTS(SELECT 1 FROM review_entries r WHERE r.id=review_cards.entry_id AND r.state='active' AND r.version=review_cards.entry_version)
 OR NOT EXISTS(SELECT 1 FROM expressions e WHERE e.id=review_cards.expression_id AND e.lifecycle='active' AND e.priority IN ('P1','P2') AND e.version=review_cards.expression_version)
 OR NOT EXISTS(SELECT 1 FROM contexts c JOIN sources s ON s.id=c.source_id WHERE c.id=review_cards.context_id AND c.expression_id=review_cards.expression_id AND c.lifecycle='active' AND c.version=review_cards.context_version AND s.version=review_cards.source_version))`);
}
