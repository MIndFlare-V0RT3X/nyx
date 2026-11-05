// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable task contracts (Phase 4 §2.1). A durable task is long-running work
// that survives restart, can be paused and resumed, retries on failure, and
// executes as a subagent so its context never pollutes the parent's window.
// The tasks table in nyx.db is the substrate; SQL leases coordinate workers
// across processes (the same primitive @nyx/runtime's lane queue uses
// in-process, expressed here across processes).

import type { SerializedError } from "./util.js";
import type { SubagentResult, SubagentSpec } from "./subagents.js";

export type TaskState = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

/**
 * Caller-authored task definition. `subagent_spec` is everything a spawn needs
 * EXCEPT the task text — the description is the task prompt (§2.1.2).
 */
export interface TaskSpec {
  /** Caller-supplied (reserved `nyx:` prefix is system tasks) or generated. */
  id?: string;
  title: string;
  /** The model-facing task prompt — becomes the subagent's task. */
  description: string;
  /** Optional: bind the task to a session (events mirror onto its log). */
  parent_session_id?: string;
  /** Everything except the task text. */
  subagent_spec: Omit<SubagentSpec, "task">;
  /** Default 3. */
  max_attempts: number;
  /**
   * Backoff base in ms; the schedule is exponential: base * 4^(attempt-1)
   * (default 1000 → 1s, 4s, 16s). A value of 0 means retry immediately.
   */
  retry_backoff_ms: number;
  /** Optional wall-clock cap for one attempt. */
  timeout_ms?: number;
  /** Default "background". */
  priority: "interactive" | "background";
  /** Optional 5-field cron — recurring task (§2.1.5). */
  schedule?: string;
}

export interface TaskRecord {
  id: string;
  /**
   * The task's OWN session — its metadata log (task.* events land here, and
   * mirrored onto the bound parent's log when one exists). Always a real,
   * resolvable session; the task's subagents hang off this session's
   * lineage. (§2.1.6: "tasks have their own session id for their metadata".)
   */
  task_session_id: string;
  spec: TaskSpec;
  state: TaskState;
  attempts: number;
  /** Worker id holding the lease (null when unleased). */
  lease_owner: string | null;
  lease_expires_at: number | null;
  /** The current attempt's child session (always a real session once set). */
  subagent_session_id: string | null;
  last_error: SerializedError | null;
  result: SubagentResult | null;
  created_at: number;
  updated_at: number;
  /** Set on retry backoff: earliest time the next attempt may run. */
  next_attempt_at: number | null;
}

export interface TaskListOptions {
  state?: TaskState[];
  parent_session_id?: string;
  limit?: number;
}

/**
 * The legal transition table (§2.1.4). Anything not listed is illegal and
 * must throw, never silently coerce (hard rule #1).
 *
 *   pending ──claim──► running ──success──► completed
 *                        │
 *                        ├──failure<max──► (backoff) ──► pending
 *                        ├──failure≥max──► failed
 *                        ├──pause()──► paused ──resume()──► pending
 *                        └──cancel()──► cancelled
 *
 * cancel() is legal from ANY state (§2.1.4 diagram); retry() is legal from
 * failed and cancelled.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["running", "paused", "cancelled"],
  running: ["completed", "failed", "pending", "paused", "cancelled"],
  paused: ["pending", "cancelled"],
  completed: ["cancelled"],
  failed: ["pending", "cancelled"],
  // cancel() is legal from ANY state (§2.1.4) — including cancelled itself
  // (idempotent re-cancel). retry() is the failed/cancelled → pending edge.
  cancelled: ["pending", "cancelled"],
};

export function isLegalTaskTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/** The task states a worker may claim (paused is never reclaimed). */
export const CLAIMABLE_TASK_STATES: readonly TaskState[] = ["pending", "running"];
