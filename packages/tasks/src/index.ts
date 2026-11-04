// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/tasks — the Phase 4 durable-task substrate: long-running work that
// survives restart, pauses and resumes, retries with backoff, recurs on
// cron, and executes as subagents so its context never pollutes the
// parent's window. Workers coordinate through SQL leases in the shared
// nyx.db — no coordination primitive beyond the conditional UPDATE.

export { TaskError, type TaskErrorCode } from "./errors.js";
export {
  TaskSqlStore,
  newWorkerId,
  rowToRecord,
  type ClaimResult,
  type TaskRow,
  type TaskStoreDeps,
} from "./store.js";
export {
  RETENTION_TASK_ID,
  SYSTEM_TASK_PREFIX,
  TaskManagerImpl,
  createTaskManager,
  isTerminal,
  type TaskManager,
  type TaskManagerDeps,
  type TaskOwnerContext,
} from "./manager.js";
export { emitTaskEvent } from "./events.js";
export {
  TaskWorkerPool,
  backoffAt,
  type TaskAttemptHandle,
  type TaskRunner,
  type TaskWorkerConfig,
  type TaskWorkerPoolDeps,
} from "./worker.js";
export {
  auditPayloadOf,
  ensureRetentionTask,
  isSystemTaskId,
  retentionTaskSpec,
  runRetention,
  runRetentionAttempt,
  type RetentionConfig,
  type RetentionDeps,
  type RetentionStats,
} from "./retention.js";
