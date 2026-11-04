// SPDX-License-Identifier: AGPL-3.0-or-later
// The task worker pool (Phase 4 §2.1.3). Each worker is an independent async
// loop over the shared tasks table: scan candidates → atomic claim → run one
// attempt through the TaskRunner → settle. Coordination is the SQL lease and
// NOTHING else — two NYX processes on the same nyx.db share the queue by
// lease contention (§2.1.3): a claim is one conditional UPDATE, so exactly
// one contender wins, and a crashed worker's lease expires (5 min TTL) and
// another worker reclaims.
//
// Lease discipline:
//   - claim   flips pending | lease-expired-running → running under me;
//   - renew   every renew_interval_ms while the attempt runs — a renew that
//             loses (lease stolen after expiry) aborts the attempt: the new
//             owner owns the run now;
//   - release on graceful shutdown: the lease EXPIRES (now), the owner name
//             stays for forensics — another worker can reclaim immediately
//             (§2.1.6), but the live attempt is aborted first so the run
//             never double-executes.
//
// Settlement discipline: after the attempt settles, the row is re-read. If
// an external transition won underneath (pause/cancel move the row BEFORE
// aborting the attempt), the worker settles NOTHING — the external winner
// owns the state and its events. If the row is still running under this
// worker's lease, the worker settles: success → completed (or pending at the
// next cron fire when recurring, §2.1.5), failure → pending+backoff
// (task.retrying) or failed at max_attempts.

import type {
  Logger,
  SerializedError,
  SessionStore,
  SubagentResult,
  TaskRecord,
} from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";
import { nextFire, parseCron } from "@nyx/runtime";
import { TaskError } from "./errors.js";
import { emitTaskEvent } from "./events.js";
import type { TaskManager } from "./manager.js";
import { newWorkerId } from "./store.js";

/** What one attempt's runner receives. */
export interface TaskAttemptHandle {
  /** Fires on pause, cancel, shutdown, timeout, and lease loss. */
  signal: AbortSignal;
  /** The runner calls this the moment the spawn created the child session. */
  setSubagentSession(subagent_session_id: string): void;
}

/**
 * How an attempt executes. The default surface implementation spawns a
 * subagent (SubagentManager.spawn) with a fresh RunContext built around the
 * task's session; system tasks (retention GC) run their own function and
 * synthesize a SubagentResult. Tests mock this.
 */
export interface TaskRunner {
  run(task: TaskRecord, handle: TaskAttemptHandle): Promise<SubagentResult>;
  /** Best-effort abort of the attempt this process is running. */
  abort(task: TaskRecord): Promise<void>;
}

export interface TaskWorkerConfig {
  /** Workers per process. Default 2 (§2.1.3). */
  workers?: number;
  /** Scan interval. Default 500ms. */
  poll_ms?: number;
  /** Lease TTL. Default 300000 (5 minutes, §2.1.3). */
  lease_ttl_ms?: number;
  /** Renewal cadence during a long run. Default 30000 (§2.1.3 step 7). */
  renew_interval_ms?: number;
  /**
   * Test hook: an artificial delay between the candidate scan and the claim,
   * widening the query→claim race window so contention is observable.
   */
  claim_delay_ms?: number;
}

export interface TaskWorkerPoolDeps {
  manager: TaskManager;
  runner: TaskRunner;
  /** The store task.* events append through (sink-wrapped on the server). */
  store: SessionStore;
  logger?: Logger;
  now?: () => number;
  config?: TaskWorkerConfig;
}

const abortError = (reason: string): Error => {
  const err = new Error(reason);
  err.name = "AbortError";
  return err;
};

class StopGate {
  private deferred: Array<() => void> = [];
  private stopped = false;

  get isStopped(): boolean {
    return this.stopped;
  }

  stop(): void {
    this.stopped = true;
    for (const resolve of this.deferred.splice(0)) resolve();
  }

  /** Resolves early on stop, or after `ms` — for responsive poll sleeps. */
  async wait(ms: number): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.deferred.indexOf(resolve);
        if (idx >= 0) this.deferred.splice(idx, 1);
        resolve();
      }, ms);
      this.deferred.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

interface RunningAttempt {
  taskId: string;
  workerId: string;
  controller: AbortController;
  renewTimer: ReturnType<typeof setInterval> | undefined;
  done: Promise<void>;
}

export class TaskWorkerPool {
  private readonly manager: TaskManager;
  private readonly runner: TaskRunner;
  private readonly store: SessionStore;
  private readonly log: Logger | undefined;
  private readonly now: () => number;
  private readonly cfg: Required<TaskWorkerConfig>;
  private readonly gate = new StopGate();
  private readonly loops: Array<Promise<void>> = [];
  private readonly running = new Map<string, RunningAttempt>();
  private started = false;

  /** Worker ids of the live loops (diagnostics/tests). */
  readonly workerIds: string[] = [];

  constructor(deps: TaskWorkerPoolDeps) {
    this.manager = deps.manager;
    this.runner = deps.runner;
    this.store = deps.store;
    this.log = deps.logger;
    this.now = deps.now ?? Date.now;
    this.cfg = {
      workers: Math.max(1, deps.config?.workers ?? 2),
      poll_ms: deps.config?.poll_ms ?? 500,
      lease_ttl_ms: deps.config?.lease_ttl_ms ?? 300_000,
      renew_interval_ms: deps.config?.renew_interval_ms ?? 30_000,
      claim_delay_ms: deps.config?.claim_delay_ms ?? 0,
    };
    // A renewal cadence at or beyond the TTL opens a recurring window where
    // the lease is expired-but-unreclaimed while the owner is mid-attempt —
    // any competitor reclaims and the task double-executes live. Loud, not
    // clamped (fan-out review R1-5).
    if (this.cfg.renew_interval_ms >= this.cfg.lease_ttl_ms) {
      throw new TaskError(
        "validation_failed",
        `tasks worker config: renew_interval_ms (${this.cfg.renew_interval_ms}) must be ` +
          `strictly less than lease_ttl_ms (${this.cfg.lease_ttl_ms})`,
      );
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (let i = 0; i < this.cfg.workers; i++) {
      const workerId = newWorkerId();
      this.workerIds.push(workerId);
      this.loops.push(this.loop(workerId));
    }
  }

  /**
   * Graceful shutdown (§2.1.6): stop scanning, abort every running attempt,
   * and RELEASE (not clear) its lease — the expiry moves to now so another
   * worker can reclaim immediately, while lease_owner keeps the forensic
   * trail of who held it.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.gate.stop();
    // Snapshot BEFORE aborting: each runOne's finally removes itself from
    // the map as it drains, so iterating the live map after allSettled
    // would see nothing left to release.
    const attempts = [...this.running.values()];
    for (const attempt of attempts) {
      attempt.controller.abort(abortError("worker pool shutting down"));
    }
    await Promise.allSettled(attempts.map((a) => a.done));
    for (const attempt of attempts) {
      try {
        this.manager.sql.releaseLease(attempt.taskId, attempt.workerId, this.now());
      } catch {
        // Row may have settled concurrently — release is best-effort.
      }
    }
    this.running.clear();
    await Promise.allSettled(this.loops);
    this.loops.length = 0;
    this.started = false;
  }

  /** How many attempts this pool is running right now (tests). */
  get runningCount(): number {
    return this.running.size;
  }

  /** Task ids this pool is running right now (route-level dispatch). */
  get runningIds(): Set<string> {
    return new Set(this.running.keys());
  }

  /** One scheduling pass over the candidates (tests drive this directly). */
  async pollOnce(workerId = newWorkerId()): Promise<number> {
    let processed = 0;
    for (const id of this.manager.sql.candidates(this.now())) {
      if (this.gate.isStopped) break;
      if (await this.runOne(id, workerId)) processed += 1;
    }
    return processed;
  }

  private async loop(workerId: string): Promise<void> {
    while (!this.gate.isStopped) {
      try {
        await this.pollOnce(workerId);
      } catch (err) {
        this.log?.error("tasks.worker_pass_failed", {
          worker_id: workerId,
          error: toSerializedError(err),
        });
      }
      await this.gate.wait(this.cfg.poll_ms);
    }
  }

  /** Claims and runs one task. True when this worker won the claim. */
  private async runOne(id: string, workerId: string): Promise<boolean> {
    if (this.cfg.claim_delay_ms > 0) {
      await this.gate.wait(this.cfg.claim_delay_ms);
    }
    const claim = this.manager.sql.claim(id, workerId, this.cfg.lease_ttl_ms, this.now());
    if (!claim.claimed || claim.task === null) return false;
    const task = claim.task;
    // Post-claim re-read guard (fan-out review R1-7): a cross-process
    // pause/cancel committing between the UPDATE and the re-read leaves a
    // claimed row that is no longer running under me — do not start work.
    if (task.state !== "running" || task.lease_owner !== workerId) return false;

    // Poison-task convergence (fan-out review R2-5): attempts incremented on
    // foreign-lease reclaims; a task that has already consumed its cap
    // through crashes settles failed instead of looping forever.
    if (task.attempts >= task.spec.max_attempts) {
      const error: SerializedError = {
        name: "TaskReclaimCapError",
        message: `task consumed ${task.attempts} attempts through lease reclaims (max ${task.spec.max_attempts})`,
        code: "reclaim_cap",
      };
      const settled = this.guardedSettle(id, workerId, "failed", {
        attempts: task.attempts,
        last_error: error,
        next_attempt_at: null,
      });
      if (settled !== null) {
        await emitTaskEvent(this.store, task, {
          type: "task.failed",
          session_id: task.task_session_id,
          task_id: id,
          error,
          attempts: task.attempts,
          ts: this.now(),
        });
      }
      return true;
    }
    const attempt = task.attempts + 1;

    // Synchronous registration BEFORE any await (fan-out review R3-2): stop()
    // snapshots this map, so the attempt must be visible from the first tick
    // after the claim wins — otherwise it escapes shutdown entirely.
    const controller = new AbortController();
    const entry: RunningAttempt = {
      taskId: id,
      workerId,
      controller,
      renewTimer: undefined,
      done: Promise.resolve(),
    };
    this.running.set(id, entry);
    // stop() won the registration race: it snapshotted before this entry
    // existed, so it will neither abort nor release this attempt — release
    // ourselves and stop here (the row is immediately reclaimable).
    if (this.gate.isStopped) {
      this.running.delete(id);
      try {
        this.manager.sql.releaseLease(id, workerId, this.now());
      } catch {
        // best-effort: the lease TTL still bounds reclaimability
      }
      return false;
    }

    // Abort delivery registered before the first await too (fan-out review
    // R2-9): a pause/cancel landing during the task.started emit must still
    // reach this attempt's controller.
    this.manager.registerRunningAttempt(id, workerId, (reason) =>
      controller.abort(abortError(reason)),
    );

    try {
      // task.started on both logs (the child id arrives via the handle below).
      await emitTaskEvent(this.store, task, {
        type: "task.started",
        session_id: task.task_session_id,
        task_id: id,
        attempt,
        subagent_session_id: null,
        ts: this.now(),
      });

      entry.renewTimer = setInterval(() => {
        // Fan-out reviews R1-2/R3-1: a thrown renew (SQLITE_BUSY beyond
        // busy_timeout, closed handle) must NEVER escape the timer callback —
        // an uncaught exception would kill the process. Log and skip: the
        // next tick retries, and the lease TTL bounds the exposure (a
        // persistent failure ends in expiry + foreign reclaim, after which
        // renewal fails by owner and aborts the attempt).
        try {
          const ok = this.manager.sql.renew(id, workerId, this.cfg.lease_ttl_ms, this.now());
          if (!ok) controller.abort(abortError("task lease lost (reclaimed by another worker)"));
        } catch (err) {
          this.log?.warn("tasks.renew_failed", {
            task_id: id,
            worker_id: workerId,
            error: toSerializedError(err),
          });
        }
      }, this.cfg.renew_interval_ms);

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      if (task.spec.timeout_ms !== undefined) {
        timeoutTimer = setTimeout(
          () => controller.abort(abortError(`task attempt timed out after ${task.spec.timeout_ms}ms`)),
          task.spec.timeout_ms,
        );
      }

      // The attempt owns its lifecycle from here; `done` never rejects —
      // every path inside is caught, including a throwing settle.
      const done = (async () => {
        try {
          const result = await this.runner.run(task, {
            signal: controller.signal,
            setSubagentSession: (subagent_session_id) => {
              this.manager.sql.setSubagentSession(id, subagent_session_id, workerId);
            },
          });
          await this.settle(id, workerId, task, attempt, result);
        } catch (err) {
          try {
            await this.settle(id, workerId, task, attempt, undefined, err);
          } catch (settleErr) {
            this.log?.error("tasks.settle_failed", {
              task_id: id,
              worker_id: workerId,
              error: toSerializedError(settleErr),
            });
          }
        } finally {
          clearInterval(entry.renewTimer);
          if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
          this.manager.unregisterRunningAttempt(id, workerId);
        }
      })();
      entry.done = done;
      await done;
    } catch (err) {
      // Setup (the task.started emit, timer creation) threw AFTER the claim:
      // leave the row reclaimable instead of holding the lease (fan-out
      // review R3-2) and let the pass-level catch log it.
      this.manager.unregisterRunningAttempt(id, workerId);
      try {
        this.manager.sql.releaseLease(id, workerId, this.now());
      } catch {
        // best-effort: the lease TTL still bounds reclaimability
      }
      throw err;
    } finally {
      this.running.delete(id);
    }
    return true;
  }

  /**
   * Settle one finished attempt. `result` is set when the runner returned;
   * `err` when it threw. The row is re-read FIRST: an external transition
   * that won underneath (pause/cancel settle the row before aborting) owns
   * the state and its events — this worker settles nothing.
   */
  private async settle(
    id: string,
    workerId: string,
    task: TaskRecord,
    attempt: number,
    result?: SubagentResult,
    err?: unknown,
  ): Promise<void> {
    // Graceful shutdown: stop() aborted this attempt and will release the
    // lease after it drains — the row MUST stay running for the next owner
    // (§2.1.6). The dying worker never retries its own aborted attempt.
    if (this.gate.isStopped) return;

    const fresh = this.manager.sql.get(id);
    if (fresh === null) return;
    if (fresh.state !== "running" || fresh.lease_owner !== workerId) {
      // External winner (paused / cancelled) or a reclaimed lease.
      return;
    }

    // ── success (§2.1.3 step 5, §2.1.5 recurring reset) ──
    if (result !== undefined && result.state === "completed") {
      if (task.spec.schedule !== undefined) {
        // Recurring: reset to pending at the next cron fire, attempt counter
        // zeroed for the new cycle. nextFire is strictly AFTER now, so the
        // reset cannot double-fire within the same window.
        const next_attempt_at = nextFire(parseCron(task.spec.schedule), this.now(), "UTC");
        const settled = this.guardedSettle(id, workerId, "pending", {
          attempts: 0,
          result,
          next_attempt_at,
        });
        if (settled === null) return;
        await emitTaskEvent(this.store, task, {
          type: "task.completed",
          session_id: task.task_session_id,
          task_id: id,
          result,
          attempts: attempt,
          ts: this.now(),
        });
        return;
      }
      const settled = this.guardedSettle(id, workerId, "completed", {
        attempts: attempt,
        result,
        // Terminal hygiene (fan-out review R2-11): no stale backoff/cron
        // timestamp survives on a terminal row.
        next_attempt_at: null,
      });
      if (settled === null) return;
      await emitTaskEvent(this.store, task, {
        type: "task.completed",
        session_id: task.task_session_id,
        task_id: id,
        result,
        attempts: attempt,
        ts: this.now(),
      });
      return;
    }

    // ── failure ladder (§2.1.3 step 6): backoff below max_attempts,
    //    terminal failed at the cap. One task.retrying per failed attempt
    //    that will retry; one task.failed at the cap. ──
    const error = failureError(result, err);
    if (attempt >= task.spec.max_attempts) {
      const settled = this.guardedSettle(id, workerId, "failed", {
        attempts: attempt,
        last_error: error,
        next_attempt_at: null,
      });
      if (settled === null) return;
      await emitTaskEvent(this.store, task, {
        type: "task.failed",
        session_id: task.task_session_id,
        task_id: id,
        error,
        attempts: attempt,
        ts: this.now(),
      });
      return;
    }
    const next_attempt_at = backoffAt(task.spec.retry_backoff_ms, attempt, this.now());
    const settled = this.guardedSettle(id, workerId, "pending", {
      attempts: attempt,
      last_error: error,
      next_attempt_at,
    });
    if (settled === null) return;
    await emitTaskEvent(this.store, task, {
      type: "task.retrying",
      session_id: task.task_session_id,
      task_id: id,
      attempt,
      next_attempt_at,
      error,
      ts: this.now(),
    });
  }

  /**
   * settleRunning with lease-loss swallowed: returning null means the row
   * moved underneath (external winner) — the caller emits nothing.
   */
  private guardedSettle(
    id: string,
    workerId: string,
    to: "completed" | "failed" | "pending",
    patch: {
      attempts?: number;
      result?: SubagentResult | null;
      last_error?: SerializedError | null;
      next_attempt_at?: number | null;
    },
  ): TaskRecord | null {
    try {
      return this.manager.sql.settleRunning(id, workerId, to, patch, this.now());
    } catch (err) {
      if (err instanceof TaskError && err.code === "lease_lost") {
        this.log?.warn("tasks.settle_lost_lease", { task_id: id, worker_id: workerId });
        return null;
      }
      throw err;
    }
  }
}

/** The serialized error of a failed attempt (result error, or a thrown one). */
function failureError(result: SubagentResult | undefined, err: unknown): SerializedError {
  if (result !== undefined && result.error !== undefined) return result.error;
  if (result !== undefined) {
    return {
      name: "TaskAttemptError",
      message: `attempt ended in state ${result.state}`,
      code: result.state,
    };
  }
  return toSerializedError(err);
}

/** Exponential backoff: base * 4^(attempt-1) — 1s, 4s, 16s (§2.1.2). */
export function backoffAt(baseMs: number, attempt: number, now: number): number {
  const factor = Math.min(Math.pow(4, Math.max(0, attempt - 1)), Math.pow(4, 20));
  return now + Math.round(baseMs * factor);
}
