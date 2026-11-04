// SPDX-License-Identifier: AGPL-3.0-or-later
// The retention archive database (Phase 4 §3). Retention MOVES a session's
// event rows out of nyx.db into a sibling file (nyx-archive.db) so the live
// database stays small while the log stays fully readable: the store
// ATTACHes the archive on the SAME connection and session.read() falls back
// to it for archived sessions (archived = 1).
//
// One connection, two databases: the store's prepared statements, pragmas
// and busy_timeout all keep working; the archive is addressed as
// `archive.<table>`. Cross-database transactions are NOT atomic across the
// two files in WAL mode — which is why the retention pass copies events
// into the archive (idempotently, INSERT OR REPLACE on the shared primary
// key) BEFORE deleting them from nyx.db inside one main-db transaction: a
// crash anywhere in between leaves the session unarchived and re-runnable,
// never half-archived, and never loses an event.

import type Database from "better-sqlite3";

/** The ATTACH alias the whole codebase addresses the archive through. */
export const ARCHIVE_ALIAS = "archive";

/** The archive sibling of a nyx.db path (same directory). */
export function archivePathOf(nyxDbPath: string): string {
  const slash = Math.max(nyxDbPath.lastIndexOf("/"), nyxDbPath.lastIndexOf("\\"));
  const dir = slash === -1 ? "" : nyxDbPath.slice(0, slash + 1);
  return `${dir}nyx-archive.db`;
}

/** The archive's event mirror: same shape, same global seqs, no FK (the
 * sessions row lives on in nyx.db — the archive is event-only by design,
 * projections stay rebuildable from the log). */
const ARCHIVE_DDL = `
CREATE TABLE IF NOT EXISTS archive.events (
  seq INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS archive.idx_events_session ON events(session_id, seq);
`;

/** True when `archive` is already ATTACHed on this connection. */
function isAttached(db: Database.Database): boolean {
  const rows = db.pragma("database_list") as Array<{ name: string }>;
  return rows.some((r) => r.name === ARCHIVE_ALIAS);
}

/**
 * Idempotently ATTACH the archive database (creating it if missing — SQLite
 * creates the file on first write) and ensure its schema. Safe to call from
 * every process that touches nyx.db: the second call is a no-op, and the
 * DDL is IF NOT EXISTS throughout. `:memory:` works (a private in-memory
 * archive — the test shape).
 */
export function ensureArchiveAttached(db: Database.Database, archivePath: string): void {
  if (!isAttached(db)) {
    // ATTACH cannot run inside a transaction; the constructor and the
    // retention pass both call this outside one.
    db.prepare(`ATTACH DATABASE ? AS ${ARCHIVE_ALIAS}`).run(archivePath);
  }
  db.exec(ARCHIVE_DDL);
}
