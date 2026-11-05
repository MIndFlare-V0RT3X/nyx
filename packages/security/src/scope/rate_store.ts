// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 (R1-10) — the SQLite-backed rate-bucket store.
//
// One row per GCRA bucket in the shared nyx.db (migration 0005), so every
// kernel process on the same database enforces the same slots: the proxy in
// process A and a tool call in process B charge the same (engagement, class,
// host) bucket. `reserve` is one better-sqlite3 transaction — get+set is
// atomic under the database's single-writer lock — and the limiter sleeps
// OUTSIDE it (see rate_limiter.ts).
//
// The table is created by the session store's migration runner when the
// shared handle opens; this store never issues DDL itself (0004 pattern).

import type { Database } from "better-sqlite3";
import type { RateBucketStore } from "./rate_limiter.js";

/** Rows untouched for this long are pruned by the next reserve() sweep. */
const STALE_MS = 3 * 60 * 60 * 1000;
/** Prune at most once per interval — reserve() stays cheap in the hot path. */
const PRUNE_EVERY_MS = 60 * 1000;

export interface SqliteRateBucketStoreDeps {
  db: Database;
  now?: () => number;
}

interface BucketRow {
  next_allowed_at: number;
  interval_ms: number;
}

export class SqliteRateBucketStore implements RateBucketStore {
  private readonly db: Database;
  private readonly now: () => number;
  private lastPrune = 0;

  constructor(deps: SqliteRateBucketStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  bucketCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM rate_buckets")
      .get() as { n: number } | undefined;
    return row?.n ?? 0;
  }

  reserve(key: string, interval_ms: number, now: number): number {
    // Atomic get+set: better-sqlite3 serializes transactions, and a busy
    // writer from another process waits on busy_timeout (the unified handle
    // opens with 5000 ms).
    const reserveTx = this.db.transaction((): number => {
      const existing = this.db
        .prepare("SELECT next_allowed_at, interval_ms FROM rate_buckets WHERE key = ?")
        .get(key) as BucketRow | undefined;
      // First acquisition waits one interval (bucket starts empty — strict
      // rate, no burst), matching the Phase 5 semantics exactly.
      const slot =
        existing === undefined
          ? now + interval_ms
          : Math.max(now, existing.next_allowed_at);
      this.db
        .prepare(
          `INSERT INTO rate_buckets (key, next_allowed_at, interval_ms, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             next_allowed_at = excluded.next_allowed_at,
             interval_ms = excluded.interval_ms,
             updated_at = excluded.updated_at`,
        )
        .run(key, slot + interval_ms, interval_ms, now);
      return slot;
    });
    const slot = reserveTx();
    this.maybePrune(now);
    return slot;
  }

  /** Lazy sweep: rows no bucket can fire again for STALE_MS are clutter. */
  private maybePrune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    this.db.prepare("DELETE FROM rate_buckets WHERE updated_at < ?").run(now - STALE_MS);
  }
}
