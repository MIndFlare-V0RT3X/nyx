// SPDX-License-Identifier: AGPL-3.0-or-later
// Hash-chained audit log. Every row's hash covers the previous row's hash,
// the canonical payload text, the actor, the action, and the creation time —
// so after the fact any edit to a committed row is detectable by walking the
// chain (see verifyAuditChain).

import { createHash } from "node:crypto";
import { canonicalJson } from "@nyx/protocol";
import type Database from "better-sqlite3";

export interface AuditEntry {
  actor: string;
  action: string;
  payload: unknown;
  /** Optional cross-reference: the session event log row this entry records. */
  event_seq?: number;
}

export interface AuditVerifyResult {
  ok: boolean;
  /** Rows successfully verified before the first bad one (all rows when ok). */
  checked: number;
  first_bad_id?: number;
}

interface AuditRow {
  id: number;
  prev_hash: string;
  hash: string;
  actor: string;
  action: string;
  payload_json: string;
  created_at: number;
  event_seq: number | null;
}

const AUDIT_DDL = `CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  event_seq INTEGER
)`;

export function ensureAuditTable(db: Database.Database): void {
  db.exec(AUDIT_DDL);
  // Migrate pre-event_seq databases in place (CREATE IF NOT EXISTS does not
  // add columns to an existing table).
  const cols = db.pragma("table_info(audit)") as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "event_seq")) {
    db.exec("ALTER TABLE audit ADD COLUMN event_seq INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS audit_event_seq ON audit(event_seq)");
  // Phase 4 §4 (§6.2 R5-4): expression indexes for the artifact-handoff
  // lookups — the audit table is append-only and cross-process; the reads
  // filter SQL-side on the JSON payload, and these keep that O(log n).
  db.exec(
    "CREATE INDEX IF NOT EXISTS audit_artifact_child ON audit(" +
      "json_extract(payload_json, '$.child_session_id'), " +
      "json_extract(payload_json, '$.path')) " +
      "WHERE action = 'subagent.artifact_written'",
  );
}

function computeHash(
  prevHash: string,
  payloadJson: string,
  actor: string,
  action: string,
  createdAt: number,
  eventSeq: number | null,
): string {
  // Back-compatible: rows without an event cross-reference hash over the
  // exact pre-1.0 material (nothing appended); rows with one extend it, so
  // tampering with the event_seq link itself breaks the chain too.
  const material =
    `${prevHash}\n${payloadJson}\n${actor}\n${action}\n${String(createdAt)}` +
    (eventSeq === null ? "" : `\n${String(eventSeq)}`);
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/**
 * Append one audit entry. The payload is stored in canonical JSON form and
 * the hash covers that exact stored text, so any later textual edit — even a
 * semantically neutral one like reordering keys — breaks the row hash.
 *
 * Transaction semantics: this function takes the db handle and issues its
 * reads/writes on that connection. When called inside a better-sqlite3
 * `db.transaction(() => ...)` block, the INSERT joins that transaction and
 * commits or rolls back together with the caller's writes (SQLite has one
 * transaction per connection; there is no separate "ambient" transaction to
 * opt into). Called outside a transaction it autocommits.
 */
export function appendAudit(
  db: Database.Database,
  entry: AuditEntry,
  opts: { now?: () => number } = {},
): void {
  ensureAuditTable(db);
  const prev = db.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as
    { hash: string } | undefined;
  const prevHash = prev?.hash ?? ""; // genesis
  const createdAt = opts.now?.() ?? Date.now();
  const payloadJson = canonicalJson(entry.payload);
  const eventSeq = entry.event_seq ?? null;
  const hash = computeHash(prevHash, payloadJson, entry.actor, entry.action, createdAt, eventSeq);
  db.prepare(
    "INSERT INTO audit (prev_hash, hash, actor, action, payload_json, created_at, event_seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(prevHash, hash, entry.actor, entry.action, payloadJson, createdAt, eventSeq);
}

/**
 * Walk the chain in id order, recomputing every hash and checking every
 * prev_hash link. Detects tampered payload/actor/action/created_at (row hash
 * no longer recomputes) and broken links (a row edited-and-rehashed, or a
 * deleted middle row, makes the next row's prev_hash wrong). Deleting the
 * LAST row leaves a fully intact chain and verifies ok — documented
 * behavior, not a defect. A full rewrite of the entire chain (every hash
 * recomputed by the attacker) is out of scope: without an externally
 * anchored checkpoint hash that is undetectable by construction.
 */
export function verifyAuditChain(db: Database.Database): AuditVerifyResult {
  ensureAuditTable(db);
  const rows = db
    .prepare(
      "SELECT id, prev_hash, hash, actor, action, payload_json, created_at, event_seq FROM audit ORDER BY id ASC",
    )
    .all() as AuditRow[];
  let prevHash = "";
  let checked = 0;
  for (const row of rows) {
    const expected = computeHash(
      row.prev_hash,
      row.payload_json,
      row.actor,
      row.action,
      row.created_at,
      row.event_seq ?? null,
    );
    if (row.hash !== expected || row.prev_hash !== prevHash) {
      return { ok: false, checked, first_bad_id: row.id };
    }
    prevHash = row.hash;
    checked += 1;
  }
  return { ok: true, checked };
}
