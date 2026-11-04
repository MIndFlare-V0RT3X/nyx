// SPDX-License-Identifier: AGPL-3.0-or-later
// Cross-process subagent abort requests. A subagent runs in the process that
// spawned it (server, or a `nyx chat` process); `nyx subagents abort <id>`
// runs in a THIRD process that cannot reach that controller in memory. The
// unified nyx.db carries the request: the CLI writes a row, the owning
// manager's poll (the same pattern the approval engine uses) reads it and
// aborts the child.
//
// Rows are NOT drained blindly: a manager only deletes a row it acted on
// (a child it aborted) or a row that is provably stale (the session is
// settled or unknown). A row for a child running in ANOTHER process is left
// in place — with a drain-all read, a bystander manager's poll could delete
// a request its owner had not yet seen, silently losing the abort (server
// and CLI local runtime can both run subagents over the same nyx.db).

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
 * Every pending request, WITHOUT deleting anything. The caller decides row
 * by row: abort the children it owns (and delete those rows), leave rows for
 * children owned by other processes, and delete rows that are provably
 * stale (settled or unknown sessions — nobody will ever act on them).
 */
export function listSubagentAbortRequests(
  db: Database.Database,
): Array<{ session_id: string; requested_at: number; actor: string }> {
  ensureSubagentControlTable(db);
  return db
    .prepare("SELECT session_id, requested_at, actor FROM subagent_abort_requests")
    .all() as Array<{ session_id: string; requested_at: number; actor: string }>;
}

/** Delete one abort request (the caller has acted on it or proven it stale). */
export function deleteSubagentAbortRequest(db: Database.Database, session_id: string): void {
  ensureSubagentControlTable(db);
  db.prepare("DELETE FROM subagent_abort_requests WHERE session_id = ?").run(session_id);
}
