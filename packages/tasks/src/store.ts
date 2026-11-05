// SPDX-License-Identifier: AGPL-3.0-or-later
// The task store: raw SQL over the `tasks` table (schema 0002_tasks_v2).
// Every mutation is a CONDITIONAL UPDATE — the WHERE clause encodes the
// state-machine edge, so legality is enforced by the database itself under
// concurrency: two racing writers cannot both win the same edge, and a
// writer whose precondition no longer holds gets 0 rows affected (which the
// caller turns into an illegal_transition / lease_lost error, never a
// silent coerce).
//
// The lease primitive (§2.1.3): a claim is a single UPDATE that flips a
// pending (or lease-expired running) row to running with THIS worker's id
// and a fresh expiry. SQLite serializes writers (one write transaction at a
// time, WAL + busy_timeout), so exactly one contender's UPDATE matches.

import type Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { canonicalJson, toSerializedError } from "@nyx/protocol";
import type {
  SerializedError,
  SubagentResult,
  TaskListOptions,
  TaskRecord,
  TaskSpec,
  TaskState,
} from "@nyx/protocol";
import { isLegalTaskTransition } from "@nyx/protocol";
import { TaskError } from "./errors.js";

export interface TaskRow {
  id: string;
  session_id: string | null;
  task_session_id: string;
  state: string;
  spec_json: string;
  lease_owner: string | null;
  lease_expires_at: number | null;
  attempts: number;
  subagent_session_id: string | null;
  last_error_json: string | null;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  next_attempt_at: number | null;
}

export interface ClaimResult {
  claimed: boolean;
  task: TaskRecord | null;
}

export interface TaskStoreDeps {
  db: Database.Database;
  now?: () => number;
}

/** One worker identity per process+slot — lease ownership name. */
export function newWorkerId(): string {
  return `worker-${process.pid}-${nanoid(6)}`;
}

const TASK_STATES: readonly TaskState[] = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
];

function isTaskState(v: string): v is TaskState {
  return (TASK_STATES as readonly string[]).includes(v);
}

export class TaskSqlStore {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(deps: TaskStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  /**
   * INSERT a new task row. Throws on id collision (caller-supplied ids are
   * unique or the create fails loudly; system ids are namespaced `nyx:`).
   */
  insert(record: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (id, session_id, task_session_id, state, spec_json, lease_owner, lease_expires_at,
                            attempts, subagent_session_id, last_error_json, result_json,
                            created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.spec.parent_session_id ?? null,
        record.task_session_id,
        record.state,
        canonicalJson(record.spec),
        record.lease_owner,
        record.lease_expires_at,
        record.attempts,
        record.subagent_session_id,
        record.last_error === null ? null : canonicalJson(record.last_error),
        record.result === null ? null : canonicalJson(record.result),
        record.created_at,
        record.updated_at,
        record.next_attempt_at,
      );
  }

  get(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row === undefined ? null : rowToRecord(row);
  }

  list(opts: TaskListOptions = {}): TaskRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.state !== undefined && opts.state.length > 0) {
      where.push(`state IN (${opts.state.map(() => "?").join(",")})`);
      params.push(...opts.state);
    }
    if (opts.parent_session_id !== undefined) {
      where.push("session_id = ?");
      params.push(opts.parent_session_id);
    }
    const limit = opts.limit ?? 100;
    params.push(limit);
    const sql =
      `SELECT * FROM tasks ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ` +
      "ORDER BY created_at DESC, id LIMIT ?";
    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map(rowToRecord);
  }

  /**
   * The worker's candidate query (§2.1.3 step 1): due pending rows and
   * running rows whose lease has expired (a crashed worker's claim).
   * Paused rows never appear; unleased-but-not-due pending rows never do.
   */
  candidates(now = this.now()): string[] {
    const rows = this.db
      .prepare(
        `SELECT id FROM tasks
          WHERE (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
             OR (state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?)
          ORDER BY created_at, id`,
      )
      .all(now, now) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /**
   * The atomic claim (§2.1.3 step 2–3). One conditional UPDATE: a DUE
   * pending row (fan-out review R2-1: due-ness is part of the claimable
   * edge — without it, a stale candidate scan bypasses retry backoff and can
   * double-fire a recurring task in its own window), a lease-expired running
   * row (a crashed worker's), or a row already leased by me — flips to
   * running with my lease.
   *
   * The attempts CASE: a pending claim or my own re-claim continues the
   * current attempt count; reclaiming a FOREIGN expired lease consumed an
   * attempt (the crashed owner's run) — incrementing bounds poison tasks
   * that crash their worker against max_attempts (fan-out review R2-5).
   * Conservative by design: a claim-then-instant-crash also counts.
   */
  claim(id: string, worker_id: string, lease_ttl_ms: number, now = this.now()): ClaimResult {
    const expires = now + lease_ttl_ms;
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET lease_owner = ?, lease_expires_at = ?, state = 'running', updated_at = ?,
                subagent_session_id = NULL,
                attempts = CASE WHEN state = 'pending' OR lease_owner = ? THEN attempts ELSE attempts + 1 END
          WHERE id = ?
            AND (
              (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (state = 'running' AND lease_expires_at < ?)
              OR lease_owner = ?
            )`,
      )
      .run(worker_id, expires, now, worker_id, id, now, now, worker_id);
    if (info.changes !== 1) {
      return { claimed: false, task: this.get(id) };
    }
    return { claimed: true, task: this.require(id) };
  }

  /**
   * Lease renewal for a live long run (§2.1.3 step 7). Conditional on STILL
   * owning the lease: if the lease expired and another worker reclaimed,
   * this UPDATE matches 0 rows and the caller must stop renewing (the new
   * owner owns the run now).
   */
  renew(id: string, worker_id: string, lease_ttl_ms: number, now = this.now()): boolean {
    const info = this.db
      .prepare(
        "UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
      )
      .run(now + lease_ttl_ms, now, id, worker_id);
    return info.changes === 1;
  }

  /**
   * Release (not clear) a lease — §2.1.6 startup/shutdown semantics. The
   * owner stays on the row for forensics but the expiry moves strictly into
   * the past, so another worker's claim predicate (lease_expires_at < now)
   * matches immediately.
   */
  releaseLease(id: string, worker_id: string, now = this.now()): void {
    this.db
      .prepare(
        "UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
      )
      .run(now - 1, now, id, worker_id);
  }

  /** Record which child session the current attempt runs as. */
  setSubagentSession(id: string, subagent_session_id: string, worker_id: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET subagent_session_id = ?, updated_at = ? WHERE id = ? AND lease_owner = ?",
      )
      .run(subagent_session_id, this.now(), id, worker_id);
  }

  /**
   * Mid-flight metadata report (spawn-time): record the child session on the
   * RUNNING task whose task-session matches. Metadata only — guarded by
   * state='running' so a late report can never touch a settled row, and no
   * lease check because the reporter runs outside the worker's lease scope.
   */
  noteSubagentSessionByTaskSession(task_session_id: string, subagent_session_id: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET subagent_session_id = ?, updated_at = ? WHERE task_session_id = ? AND state = 'running'",
      )
      .run(subagent_session_id, this.now(), task_session_id);
  }

  /** Directly set next_attempt_at (retry()'s cron re-anchor). */
  setNextAttemptAt(id: string, next_attempt_at: number): void {
    this.db
      .prepare("UPDATE tasks SET next_attempt_at = ?, updated_at = ? WHERE id = ?")
      .run(next_attempt_at, this.now(), id);
  }

  /**
   * Terminal or retrying settlement of a running attempt, executed by the
   * lease owner. `to` names the target state; the WHERE clause demands the
   * row still be running under MY lease — if the lease was lost (crash +
   * reclaim), this matches 0 rows and the caller learns lease_lost instead
   * of overwriting the new owner's state. A non-running row is ALWAYS
   * lease_lost (fan-out review R2-2: never report a lost row as settled).
   */
  settleRunning(
    id: string,
    worker_id: string,
    to: "completed" | "failed" | "pending" | "paused" | "cancelled",
    patch: {
      attempts?: number;
      result?: SubagentResult | null;
      last_error?: SerializedError | null;
      next_attempt_at?: number | null;
    } = {},
    now = this.now(),
  ): TaskRecord {
    const before = this.get(id);
    if (before === null) throw new TaskError("not_found", `task ${id} not found`);
    if (before.state !== "running") {
      // An external transition (pause/cancel) already moved the row, or a
      // foreign owner settled it: this worker lost the row. Report it —
      // never a silent success (fan-out review R2-2).
      throw new TaskError(
        "lease_lost",
        `task ${id} is no longer running (state=${before.state}); ` +
          `cannot settle to ${to} from a lost lease`,
      );
    }
    if (before.lease_owner !== worker_id) {
      throw new TaskError(
        "lease_lost",
        `task ${id} is leased by ${before.lease_owner ?? "(none)"}, not ${worker_id}`,
      );
    }
    if (!isLegalTaskTransition("running", to)) {
      throw new TaskError(
        "illegal_transition",
        `illegal task transition running → ${to} (task ${id})`,
      );
    }
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET state = ?, attempts = ?, result_json = ?, last_error_json = ?, next_attempt_at = ?,
                lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND state = 'running' AND lease_owner = ?`,
      )
      .run(
        to,
        patch.attempts ?? before.attempts,
        patch.result === undefined
          ? before.result === null
            ? null
            : canonicalJson(before.result)
          : patch.result === null
            ? null
            : canonicalJson(patch.result),
        patch.last_error === undefined
          ? before.last_error === null
            ? null
            : canonicalJson(before.last_error)
          : patch.last_error === null
            ? null
            : canonicalJson(patch.last_error),
        patch.next_attempt_at === undefined ? before.next_attempt_at : patch.next_attempt_at,
        // A settled row carries no lease (every settle target is non-running).
        null,
        null,
        now,
        id,
        worker_id,
      );
    if (info.changes !== 1) {
      throw new TaskError(
        "lease_lost",
        `task ${id} slipped out from under lease owner ${worker_id} during settle`,
      );
    }
    return this.require(id);
  }

  /**
   * An externally-driven transition (pause/resume/cancel/retry — §2.1.4).
   * The WHERE clause enforces the edge; 0 rows affected = illegal transition
   * (or not found), which THROWS (hard rule #1: never silently coerce).
   *
   * Fan-out review hardening (R2-3, R2-4/R3-3): every member of `fromList`
   * must itself have a legal edge to `to` — the WHERE then encodes the edge
   * completely, with no TOCTOU gap between the pre-check and the UPDATE.
   * `attempts`/`next_attempt_at` are computed SQL-side (CASE), never from
   * the pre-read, so a concurrent settle's columns cannot be clobbered by a
   * cross-process transition.
   */
  transition(
    id: string,
    from: TaskState | TaskState[],
    to: TaskState,
    extra: { reset_attempts?: boolean; clear_next_attempt?: boolean } = {},
    now = this.now(),
  ): TaskRecord {
    const fromList = Array.isArray(from) ? from : [from];
    for (const src of fromList) {
      if (!isLegalTaskTransition(src, to)) {
        throw new TaskError(
          "illegal_transition",
          `illegal task transition ${src} → ${to} declared by caller (task ${id})`,
        );
      }
    }
    const before = this.get(id);
    if (before === null) throw new TaskError("not_found", `task ${id} not found`);
    if (!fromList.includes(before.state)) {
      throw new TaskError(
        "illegal_transition",
        `illegal task transition ${before.state} → ${to} (task ${id}); ` +
          `legal sources: ${fromList.join("|")}`,
      );
    }
    if (!isLegalTaskTransition(before.state, to)) {
      throw new TaskError(
        "illegal_transition",
        `illegal task transition ${before.state} → ${to} (task ${id})`,
      );
    }
    const info = this.db
      .prepare(
        `UPDATE tasks
            SET state = ?,
                attempts = CASE WHEN ? THEN 0 ELSE attempts END,
                lease_owner = NULL,
                lease_expires_at = NULL,
                next_attempt_at = CASE WHEN ? THEN NULL ELSE next_attempt_at END,
                updated_at = ?
          WHERE id = ? AND state IN (${fromList.map(() => "?").join(",")})`,
      )
      .run(
        to,
        extra.reset_attempts === true ? 1 : 0,
        extra.clear_next_attempt === true ? 1 : 0,
        now,
        id,
        ...fromList,
      );
    if (info.changes !== 1) {
      // Raced with another writer moving the row first.
      const raced = this.get(id);
      throw new TaskError(
        "illegal_transition",
        `task ${id} transition ${fromList.join("|")} → ${to} lost the race ` +
          `(now state=${raced?.state ?? "?"})`,
      );
    }
    return this.require(id);
  }

  require(id: string): TaskRecord {
    const rec = this.get(id);
    if (rec === null) throw new TaskError("not_found", `task ${id} not found`);
    return rec;
  }
}

export function rowToRecord(row: TaskRow): TaskRecord {
  if (!isTaskState(row.state)) {
    throw new TaskError("validation_failed", `task row ${row.id} has unknown state "${row.state}"`);
  }
  return {
    id: row.id,
    task_session_id: row.task_session_id,
    spec: JSON.parse(row.spec_json) as TaskSpec,
    state: row.state,
    attempts: row.attempts,
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at,
    subagent_session_id: row.subagent_session_id,
    last_error:
      row.last_error_json === null ? null : (JSON.parse(row.last_error_json) as SerializedError),
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as SubagentResult),
    created_at: row.created_at,
    updated_at: row.updated_at,
    next_attempt_at: row.next_attempt_at,
  };
}

/** Serialize an unknown error for last_error storage. */
export function serialized(err: unknown): SerializedError {
  return toSerializedError(err);
}
