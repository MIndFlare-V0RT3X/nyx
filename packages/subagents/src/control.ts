// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-process subagent abort requests. A subagent runs in the process that
// spawned it (server, or a `nyx chat` process); `nyx subagents abort <id>`
// runs in a THIRD process that cannot reach that controller in memory. The
// unified nyx.db carries the request: the CLI writes a row, the owning
// manager's poll (the same pattern the approval engine uses) drains it and
// aborts the child. Rows for children nobody runs are drained as stale —
// aborting a finished subagent is a no-op.

import type Database from "better-sqlite3";

const DDL = `CREATE TABLE IF NOT EXISTS subagent_abort_requests (
  session_id TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  actor TEXT NOT NULL
)`;

export function ensureSubagentControlTable(db: Database.Database): void {
  db.exec(DDL);
}

/** Record an abort request for a subagent session (idempotent per session). */
export function requestSubagentAbort(
  db: Database.Database,
  session_id: string,
  actor: string,
  now: number = Date.now(),
): void {
  ensureSubagentControlTable(db);
  db.prepare(
    `INSERT INTO subagent_abort_requests (session_id, requested_at, actor)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET requested_at = excluded.requested_at, actor = excluded.actor`,
  ).run(session_id, now, actor);
}

/**
 * Drain every pending request and return the session ids. The caller decides
 * which of them it owns (running children); the rest are stale by
 * construction — an abort request can only name an already-spawned child, and
 * a child that finished between write and poll needs no abort.
 */
export function takeSubagentAbortRequests(db: Database.Database): string[] {
  ensureSubagentControlTable(db);
  const rows = db
    .prepare("SELECT session_id FROM subagent_abort_requests")
    .all() as Array<{ session_id: string }>;
  if (rows.length === 0) return [];
  db.prepare("DELETE FROM subagent_abort_requests").run();
  return rows.map((r) => r.session_id);
}
