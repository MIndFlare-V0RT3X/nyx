// SPDX-License-Identifier: AGPL-3.0-or-later
// The TaskManager (Phase 4 §2.1.2/§2.1.4): the surface-facing CRUD + state
// machine over the task store. Every successful transition emits its task.*
// event on the task's own session log AND (when the task is bound) on the
// parent session's log — the transition winner emits; a caller whose
// transition loses (illegal or raced) gets a thrown TaskError, never a
// silent coerce (hard rule #1).
//
// create() resolves the task's owner/persona (hard rule #6): a bound task
// inherits them from its parent session (cross-owner creation throws), an
// unbound one takes them from the caller's owner context. The task's own
// session — where its metadata log lives and where its subagents hang off —
// is created here, so a task record is never without a real session.

import { nanoid } from "nanoid";
import type Database from "better-sqlite3";
import { TaskSpecSchema } from "@nyx/protocol";
import type {
  Logger,
  SessionEvent,
  SessionStore,
  TaskListOptions,
  TaskRecord,
  TaskSpec,
  TaskState,
} from "@nyx/protocol";
import { nextFire, parseCron } from "@nyx/runtime";
import { TaskError } from "./errors.js";
import { TaskSqlStore } from "./store.js";

/**
 * The owner context a create() needs — the brief's `owner_ctx: RunContext`
 * narrowed to what task creation actually consumes (owner + persona). The
 * full RunContext stays with the surface: the worker builds its own context
 * per attempt through the TaskRunner.
 */
export interface TaskOwnerContext {
  owner_id: string;
  persona_id: string;
}

export interface TaskManagerDeps {
  /** The unified nyx.db handle (tasks table + cross-process leases). */
  db: Database.Database;
  /**
   * The session store appends route through — in the server this is the
   * sink-wrapped store (single serialized writer); in the CLI the raw store.
   */
  store: SessionStore;
  /** Optional logger — warns on dropped parent-mirror events (fan-out R3-6). */
  logger?: Logger;
  now?: () => number;
}

/** Reserved id prefix for harness-owned tasks (retention GC, …). */
export const SYSTEM_TASK_PREFIX = "nyx:";

/** The recurring retention task's id (§3, wired by the surface). */
export const RETENTION_TASK_ID = `${SYSTEM_TASK_PREFIX}retention-gc`;

export interface TaskAttemptAbort {
  /** Abort the in-process running attempt (registered by the worker pool). */
  (task_id: string, reason: string): void;
}

export class TaskManagerImpl {
  readonly sql: TaskSqlStore;
  private readonly store: SessionStore;
  private readonly log: Logger | undefined;
  private readonly now: () => number;
  /**
   * task_id → the in-process attempt's abort. Keyed by worker id so a stale
   * worker's cleanup cannot unregister its reclaim successor's abort
   * (fan-out review R1-4).
   */
  private readonly runningAttempts = new Map<
    string,
    { workerId: string; abort: (reason: string) => void }
  >();

  constructor(deps: TaskManagerDeps) {
    this.sql = new TaskSqlStore({ db: deps.db, now: deps.now });
    this.store = deps.store;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
  }

  /** Worker pool registration: how pause/cancel reach a live attempt. */
  registerRunningAttempt(task_id: string, workerId: string, abort: (reason: string) => void): void {
    this.runningAttempts.set(task_id, { workerId, abort });
  }

  unregisterRunningAttempt(task_id: string, workerId: string): void {
    const entry = this.runningAttempts.get(task_id);
    if (entry !== undefined && entry.workerId === workerId) {
      this.runningAttempts.delete(task_id);
    }
  }

  async create(
    spec: TaskSpec,
    owner_ctx: TaskOwnerContext,
    opts: { system?: boolean } = {},
  ): Promise<TaskRecord> {
    const parsed = TaskSpecSchema.safeParse(spec);
    if (!parsed.success) {
      throw new TaskError(
        "validation_failed",
        `task spec invalid: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"} ${i.message}`)
          .join("; ")}`,
      );
    }
    const s = parsed.data;
    const id = s.id ?? `task-${nanoid(10)}`;
    if (id.startsWith(SYSTEM_TASK_PREFIX) && opts.system !== true) {
      throw new TaskError(
        "validation_failed",
        `task id prefix "${SYSTEM_TASK_PREFIX}" is reserved for harness tasks`,
      );
    }

    // Owner/persona resolution (hard rule #6): a bound task inherits from its
    // parent session and refuses a cross-owner caller.
    let owner_id = owner_ctx.owner_id;
    let persona_id = owner_ctx.persona_id;
    let engagement: Parameters<SessionStore["create"]>[0]["engagement"] = null;
    if (s.parent_session_id !== undefined) {
      const parent = await this.store.meta(s.parent_session_id);
      if (parent === null) {
        throw new TaskError(
          "not_found",
          `task ${id}: parent session ${s.parent_session_id} not found`,
        );
      }
      if (parent.owner_id !== owner_ctx.owner_id) {
        throw new TaskError(
          "validation_failed",
          `task ${id}: cross-owner creation refused (parent ${s.parent_session_id} ` +
            `belongs to ${parent.owner_id}, caller is ${owner_ctx.owner_id})`,
        );
      }
      owner_id = parent.owner_id;
      persona_id = parent.persona_id;
      engagement = parent.engagement;
    }

    // The task's own session: metadata log + subagent lineage root.
    const taskSession = await this.store.create({
      owner_id,
      persona_id,
      title: `task: ${s.title.slice(0, 60)}`,
      engagement,
    });

    // Recurring tasks start at their first cron fire (§2.1.5); one-shot
    // tasks are due immediately.
    let next_attempt_at: number | null = null;
    if (s.schedule !== undefined) {
      try {
        next_attempt_at = nextFire(parseCron(s.schedule), this.now(), "UTC");
      } catch (err) {
        throw new TaskError(
          "validation_failed",
          `task ${id}: invalid schedule "${s.schedule}": ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const now = this.now();
    const record: TaskRecord = {
      id,
      task_session_id: taskSession.session_id,
      spec: { ...s, id },
      state: "pending",
      attempts: 0,
      lease_owner: null,
      lease_expires_at: null,
      subagent_session_id: null,
      last_error: null,
      result: null,
      created_at: now,
      updated_at: now,
      next_attempt_at,
    };
    try {
      this.sql.insert(record);
    } catch (err) {
      throw new TaskError(
        "validation_failed",
        `task ${id} could not be created: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.emit(record, {
      type: "task.created",
      session_id: record.task_session_id,
      task_id: id,
      title: s.title,
      spec: record.spec,
      ts: now,
    });
    return record;
  }

  async get(id: string): Promise<TaskRecord | null> {
    return this.sql.get(id);
  }

  async list(opts: TaskListOptions = {}): Promise<TaskRecord[]> {
    return this.sql.list(opts);
  }

  /** pending|running → paused. A running attempt is aborted (§2.1.4). */
  async pause(id: string): Promise<void> {
    const record = this.sql.transition(id, ["pending", "running"], "paused");
    this.runningAttempts.get(id)?.abort("task paused");
    await this.emit(record, {
      type: "task.paused",
      session_id: record.task_session_id,
      task_id: id,
      ts: this.now(),
    });
  }

  /** paused → pending; clears the lease so a worker can reclaim (§2.1.4). */
  async resume(id: string): Promise<void> {
    const record = this.sql.transition(id, "paused", "pending", {
      clear_next_attempt: true,
    });
    await this.emit(record, {
      type: "task.resumed",
      session_id: record.task_session_id,
      task_id: id,
      ts: this.now(),
    });
  }

  /** any → cancelled. A running attempt is aborted (§2.1.4 diagram). */
  async cancel(id: string): Promise<void> {
    const record = this.sql.transition(
      id,
      ["pending", "running", "paused", "completed", "failed", "cancelled"],
      "cancelled",
    );
    this.runningAttempts.get(id)?.abort("task cancelled");
    await this.emit(record, {
      type: "task.cancelled",
      session_id: record.task_session_id,
      task_id: id,
      ts: this.now(),
    });
  }

  /**
   * failed|cancelled → pending, attempts reset (§2.1.2). A SCHEDULED task
   * re-anchors to its next cron fire instead of running immediately
   * (fan-out review R2-6); a one-shot task is due right away.
   */
  async retry(id: string): Promise<void> {
    const record = this.sql.transition(id, ["failed", "cancelled"], "pending", {
      reset_attempts: true,
      ...(this.recordOf(id).spec.schedule === undefined
        ? { clear_next_attempt: true }
        : {}),
    });
    if (record.spec.schedule !== undefined) {
      // Re-anchor the cron: the schedule governs when a revived recurring
      // task may fire again.
      this.sql.setNextAttemptAt(id, nextFire(parseCron(record.spec.schedule), this.now(), "UTC"));
    }
    await this.emit(record, {
      type: "task.resumed",
      session_id: record.task_session_id,
      task_id: id,
      ts: this.now(),
    });
  }

  /**
   * Appends a task.* event to the task's own log, then (when bound) the
   * mirrored copy to the parent session's log (§2.1.6). A failed mirror
   * append is logged but does not fail the transition — the task's own log
   * is the record of truth; the parent copy is a notification.
   */
  private async emit(record: TaskRecord, event: SessionEvent): Promise<void> {
    await this.store.append(record.task_session_id, [event]);
    const parent = record.spec.parent_session_id;
    if (parent !== undefined && parent !== record.task_session_id) {
      try {
        await this.store.append(parent, [{ ...event, session_id: parent } as SessionEvent]);
      } catch (err) {
        // A deleted/archived parent must not break task bookkeeping.
        this.log?.warn("tasks.parent_mirror_failed", {
          task_id: record.id,
          parent_session_id: parent,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Read-before-transition helper (retry's schedule check). */
  private recordOf(id: string): TaskRecord {
    return this.sql.require(id);
  }
}

export interface TaskManager {
  /** The raw SQL layer — the worker's lease/candidate path. */
  readonly sql: TaskSqlStore;
  create(spec: TaskSpec, owner_ctx: TaskOwnerContext, opts?: { system?: boolean }): Promise<TaskRecord>;
  get(id: string): Promise<TaskRecord | null>;
  list(opts?: TaskListOptions): Promise<TaskRecord[]>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  cancel(id: string): Promise<void>;
  retry(id: string): Promise<void>;
  /** Worker-pool wiring (in-process abort delivery for pause/cancel). */
  registerRunningAttempt(task_id: string, workerId: string, abort: (reason: string) => void): void;
  unregisterRunningAttempt(task_id: string, workerId: string): void;
}

export function createTaskManager(deps: TaskManagerDeps): TaskManager {
  return new TaskManagerImpl(deps);
}

/** Exposed for the worker: state helpers shared with the surface. */
export function isTerminal(state: TaskState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}
