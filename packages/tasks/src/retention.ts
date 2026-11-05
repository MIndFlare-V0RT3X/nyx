// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 4 §3 — the retention engine, and the durable task that runs it.
//
// Retention ARCHIVES, it does not delete: a session past its window has its
// event rows MOVED to the sibling archive database (nyx-archive.db,
// ATTACHed on the same connection) and its sessions row marked
// archived = 1 / archived_at. The session stays resolvable (meta(), and
// list() with include_archived) and fully readable — session.read() serves
// the events from the archive. Hard deletion is a separate, opt-in second
// pass (delete_after_days, default off) that only ever touches sessions
// that are ALREADY archived.
//
// What is protected, always (hard rule: live work is never archived):
//   - sessions of tasks in pending / running / paused — a scheduled or
//     mid-flight task's own log, its current attempt's child session, and
//     the parent session it mirrors events onto;
//   - sessions tied to FAILED tasks, unless the scope explicitly includes
//     failed work ("subagent+failed", "all") — failure evidence has
//     forensic value and is kept by default.
//
// Crash discipline: the per-session copy into the archive is idempotent
// (INSERT OR REPLACE over the shared global seq primary key) and happens
// BEFORE the main-db transaction that deletes the events and marks the row.
// A crash at any point leaves the pass safely re-runnable and never loses
// an event: at worst the data exists in both files until the next pass.
//
// The engine runs as the `nyx:retention-gc` durable task (§3's "retention
// is a scheduled durable task, not a startup sweep"): created by the
// surface at boot when the operator opts in (subagents.retention_enabled,
// default false), firing on subagents.retention_schedule (default daily
// 03:30 UTC). System tasks do not spawn a subagent — the runner branch
// calls runRetention() directly and synthesizes the SubagentResult.

import type Database from "better-sqlite3";
import { appendAudit } from "@nyx/policy";
import { canonicalJson } from "@nyx/protocol";
import type { SubagentResult, TaskSpec } from "@nyx/protocol";
import { ensureArchiveAttached } from "@nyx/session";
import { RETENTION_TASK_ID, SYSTEM_TASK_PREFIX } from "./manager.js";

/** The retention knobs (subagents.* in nyx.config.yaml). */
export interface RetentionConfig {
  /** Days after last activity before archiving. 0 = never archive. */
  retention_days: number;
  /** Which session classes retention may archive. */
  retention_scope: "subagent" | "subagent+failed" | "all" | "none";
  /**
   * Days after ARCHIVING before hard-deleting (archive events + the
   * sessions row). 0 = off (default). Only ever applies to archived
   * sessions — live and soft-archived rows are never hard-deleted.
   */
  delete_after_days: number;
}

export interface RetentionStats {
  /** Sessions examined as archive candidates. */
  scanned: number;
  /** Sessions archived this pass (events moved to the archive db). */
  archived_sessions: number;
  /** Event rows moved this pass. */
  archived_events: number;
  /** Sessions kept because a live (pending/running/paused) task ties them. */
  protected_live: number;
  /** Sessions kept because a failed task ties them and the scope excludes failed. */
  protected_failed: number;
  /** Sessions hard-deleted this pass (delete_after_days pass). */
  deleted_sessions: number;
  /** Archive event rows removed by the deletion pass. */
  deleted_events: number;
}

export interface RetentionDeps {
  /** The unified nyx.db handle (sessions/events/tasks/audit). */
  db: Database.Database;
  /**
   * The archive database path — same directory as nyx.db by convention
   * (archivePathOf()). ATTACHed idempotently; ":memory:" works for tests.
   */
  archivePath: string;
  config: RetentionConfig;
  now?: () => number;
  /** Test hook: skip the audit appends (chain assertions run separately). */
  audit?: boolean;
}

const DAY_MS = 86_400_000;

/** True for the task ids whose sessions the system-task runner owns. */
export function isSystemTaskId(task_id: string): boolean {
  return task_id.startsWith(SYSTEM_TASK_PREFIX);
}

/**
 * The `nyx:retention-gc` TaskSpec. subagent_spec is empty by design: system
 * tasks never spawn — the runner branch executes runRetention() directly,
 * so there is no model spend to budget.
 */
export function retentionTaskSpec(config: { retention_schedule: string }): TaskSpec {
  return {
    id: RETENTION_TASK_ID,
    title: "retention gc",
    description:
      "System task (no subagent spawn): archive sessions past the retention " +
      "window to nyx-archive.db, then hard-delete archived sessions past " +
      "delete_after_days. Scope, windows and protection rules come from the " +
      "subagents.* config keys; every pass appends a hash-chained audit row " +
      "when it moves or deletes anything.",
    subagent_spec: {},
    max_attempts: 3,
    retry_backoff_ms: 60_000,
    priority: "background",
    schedule: config.retention_schedule,
  };
}

/**
 * One retention pass. Synchronous by design — it is pure SQL over the
 * shared handle, fast enough that a "running" lease never comes close to
 * its TTL, and transactional per session so a crash bounds the loss to
 * "run it again tomorrow (or on the next retry)".
 */
export function runRetention(deps: RetentionDeps): RetentionStats {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;
  const audit = deps.audit !== false;
  ensureArchiveAttached(db, deps.archivePath);

  const stats: RetentionStats = {
    scanned: 0,
    archived_sessions: 0,
    archived_events: 0,
    protected_live: 0,
    protected_failed: 0,
    deleted_sessions: 0,
    deleted_events: 0,
  };

  // ── pass 1: archive ──
  if (config.retention_days > 0 && config.retention_scope !== "none") {
    const cutoff = now() - config.retention_days * DAY_MS;
    const includeFailed =
      config.retention_scope === "subagent+failed" || config.retention_scope === "all";
    // A session is tied to a task when the task owns it (task_session_id),
    // is running its attempt in it (subagent_session_id), or mirrors its
    // lifecycle events onto it (session_id — the bound parent).
    const tie = "(t.task_session_id = s.id OR t.subagent_session_id = s.id OR t.session_id = s.id)";
    // Scope shape: which kinds are eligible at all. "subagent" and
    // "subagent+failed" are subagent-kind only; "subagent+failed" widens
    // the PROTECTION, not the kinds — failed tasks' own sessions (kind
    // 'session') join the eligible set there.
    const kindFilter =
      config.retention_scope === "all"
        ? ""
        : config.retention_scope === "subagent+failed"
          ? " AND (s.kind = 'subagent' OR EXISTS (SELECT 1 FROM tasks ft WHERE ft.task_session_id = s.id AND ft.state = 'failed'))"
          : " AND s.kind = 'subagent'";
    const rows = db
      .prepare(
        `SELECT s.id,
                EXISTS (SELECT 1 FROM tasks t WHERE ${tie} AND t.state IN ('pending','running','paused')) AS live_tied,
                EXISTS (SELECT 1 FROM tasks t WHERE ${tie} AND t.state = 'failed') AS failed_tied
           FROM sessions s
          WHERE s.archived = 0 AND s.updated_at <= ?${kindFilter}
          ORDER BY s.updated_at, s.id`,
      )
      .all(cutoff) as Array<{ id: string; live_tied: 0 | 1; failed_tied: 0 | 1 }>;
    stats.scanned = rows.length;

    for (const row of rows) {
      if (row.live_tied === 1) {
        stats.protected_live += 1;
        continue;
      }
      if (row.failed_tied === 1 && !includeFailed) {
        stats.protected_failed += 1;
        continue;
      }
      stats.archived_sessions += 1;
      stats.archived_events += archiveOne(db, row.id, now());
    }

    if (audit && stats.archived_sessions > 0) {
      appendAudit(
        db,
        {
          actor: RETENTION_TASK_ID,
          action: "retention.archived",
          payload: {
            scope: config.retention_scope,
            retention_days: config.retention_days,
            scanned: stats.scanned,
            archived_sessions: stats.archived_sessions,
            archived_events: stats.archived_events,
            protected_live: stats.protected_live,
            protected_failed: stats.protected_failed,
          },
        },
        { now },
      );
    }
  }

  // ── pass 2: hard-delete (opt-in; archived rows only) ──
  if (config.delete_after_days > 0) {
    const cutoff = now() - config.delete_after_days * DAY_MS;
    const rows = db
      .prepare(
        "SELECT id FROM sessions WHERE archived = 1 AND archived_at IS NOT NULL AND archived_at <= ?",
      )
      .all(cutoff) as Array<{ id: string }>;
    for (const row of rows) {
      stats.deleted_sessions += 1;
      stats.deleted_events += deleteOne(db, row.id);
    }
    if (audit && stats.deleted_sessions > 0) {
      appendAudit(
        db,
        {
          actor: RETENTION_TASK_ID,
          action: "retention.deleted",
          payload: {
            delete_after_days: config.delete_after_days,
            deleted_sessions: stats.deleted_sessions,
            deleted_events: stats.deleted_events,
          },
        },
        { now },
      );
    }
  }

  return stats;
}

/**
 * Move one session's log to the archive. Copy first (idempotent,
 * crash-safe), then one main-db transaction: delete events + rebuildable
 * projections + projection cursor, mark the row. archived_at keeps a
 * pre-existing soft-archive timestamp (COALESCE) — the original archive
 * time is evidence too.
 */
function archiveOne(db: Database.Database, session_id: string, now: number): number {
  const copy = db.prepare(
    `INSERT OR REPLACE INTO archive.events (seq, session_id, type, payload_json, ts)
     SELECT seq, session_id, type, payload_json, ts FROM events WHERE session_id = ?`,
  );
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
    .get(session_id) as {
    n: number;
  };
  copy.run(session_id);
  const txn = db.transaction(() => {
    db.prepare("DELETE FROM events WHERE session_id = ?").run(session_id);
    db.prepare("DELETE FROM messages WHERE session_id = ?").run(session_id);
    db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(session_id);
    db.prepare("DELETE FROM approvals WHERE session_id = ?").run(session_id);
    db.prepare("DELETE FROM projection_version WHERE name = ?").run(session_id);
    db.prepare(
      "UPDATE sessions SET archived = 1, archived_at = COALESCE(archived_at, ?), updated_at = ? WHERE id = ?",
    ).run(now, now, session_id);
  });
  txn();
  return count.n;
}

/** Hard-delete one archived session: archive events, then the sessions row. */
function deleteOne(db: Database.Database, session_id: string): number {
  const count = db
    .prepare("SELECT COUNT(*) AS n FROM archive.events WHERE session_id = ?")
    .get(session_id) as { n: number };
  db.prepare("DELETE FROM archive.events WHERE session_id = ?").run(session_id);
  db.prepare("DELETE FROM sessions WHERE id = ? AND archived = 1").run(session_id);
  return count.n;
}

/**
 * Surface wiring: make sure the `nyx:retention-gc` durable task exists and
 * is schedulable. Called at boot when the operator opted in
 * (subagents.retention_enabled). Idempotent: creates the task when absent,
 * revives it when a previous pass terminally failed or was cancelled (the
 * config is the source of truth for a system task), and leaves a healthy
 * or deliberately paused task exactly as it is.
 */
export async function ensureRetentionTask(
  manager: {
    create(
      spec: TaskSpec,
      owner_ctx: { owner_id: string; persona_id: string },
      opts?: { system?: boolean },
    ): Promise<unknown>;
    get(id: string): Promise<{ state: string } | null>;
    retry(id: string): Promise<void>;
  },
  config: { retention_schedule: string },
  owner_ctx: { owner_id: string; persona_id: string },
): Promise<void> {
  const existing = await manager.get(RETENTION_TASK_ID);
  if (existing === null) {
    await manager.create(retentionTaskSpec(config), owner_ctx, { system: true });
    return;
  }
  if (existing.state === "failed" || existing.state === "cancelled") {
    await manager.retry(RETENTION_TASK_ID);
  }
}

/**
 * The system-task runner branch: executes the retention pass and
 * synthesizes the SubagentResult (no subagent, no model spend). The
 * summary is the operator-facing one-liner; the counts land in the audit
 * chain and on the task's own session log via task.completed.
 */
export async function runRetentionAttempt(
  deps: RetentionDeps,
  task_session_id: string,
  started_at: number,
  now: () => number = Date.now,
): Promise<SubagentResult> {
  const stats = runRetention(deps);
  const summary =
    `retention: archived ${stats.archived_sessions} session(s), ` +
    `${stats.archived_events} event(s); deleted ${stats.deleted_sessions} session(s), ` +
    `${stats.deleted_events} event(s)` +
    (stats.protected_live + stats.protected_failed > 0
      ? `; kept ${stats.protected_live} live-tied, ${stats.protected_failed} failed-tied`
      : "");
  return {
    session_id: task_session_id,
    summary,
    state: "completed",
    tokens_used: 0,
    duration_ms: Math.max(0, now() - started_at),
  };
}

/** Exposed for tests: the canonical stats payload the audit row carries. */
export function auditPayloadOf(stats: RetentionStats, config: RetentionConfig): string {
  return canonicalJson({
    scope: config.retention_scope,
    retention_days: config.retention_days,
    ...stats,
  });
}
