// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx tasks` — inspect and drive durable tasks from a separate process.
// Reads go straight to the tasks table in nyx.db; mutations (pause/resume/
// retry/cancel) go through the TaskManager's conditional transitions, and a
// cancel of a RUNNING task additionally leaves a subagent_abort_requests
// row so the process actually running the attempt aborts its child (the
// same cross-process pattern `nyx subagents abort` uses).

import Database from "better-sqlite3";
import { createTaskManager, type TaskManager } from "@nyx/tasks";
import { requestSubagentAbort } from "@nyx/subagents";
import type { TaskRecord, TaskState } from "@nyx/protocol";
import { openSessionStore } from "@nyx/session";
import { CliError } from "./errors.js";
import { formatTimestamp, truncate } from "./format.js";
import { renderTable } from "./table.js";

interface TaskCli {
  db: Database.Database;
  manager: TaskManager;
  close(): void;
}

function openTasks(data_dir: string): TaskCli {
  const db = new Database(`${data_dir}/nyx.db`);
  db.pragma("busy_timeout = 5000");
  const store = openSessionStore(`${data_dir}/nyx.db`, { db });
  const manager = createTaskManager({ db, store });
  return { db, store, manager, close: () => store.close() } as TaskCli;
}

export async function listTasks(
  data_dir: string,
  opts: { state?: string; parent_session_id?: string; limit?: number } = {},
): Promise<TaskRecord[]> {
  const cli = openTasks(data_dir);
  try {
    let state: TaskState[] | undefined;
    if (opts.state !== undefined && opts.state.length > 0) {
      const raw = opts.state.split(",").map((s) => s.trim()) as TaskState[];
      const valid = ["pending", "running", "paused", "completed", "failed", "cancelled"];
      if (raw.some((s) => !valid.includes(s))) {
        throw new CliError("validation_failed", `unknown task state in "${opts.state}"`);
      }
      state = raw;
    }
    return await cli.manager.list({
      ...(state !== undefined ? { state } : {}),
      ...(opts.parent_session_id !== undefined
        ? { parent_session_id: opts.parent_session_id }
        : {}),
      limit: opts.limit ?? 50,
    });
  } finally {
    cli.close();
    cli.db.close();
  }
}

export function renderTaskList(records: readonly TaskRecord[]): string {
  if (records.length === 0) return "(no tasks)";
  return renderTable(
    ["task", "state", "attempts", "next attempt", "title"],
    records.map((r) => [
      r.id,
      r.state,
      `${r.attempts}/${r.spec.max_attempts}`,
      r.next_attempt_at === null ? "-" : formatTimestamp(r.next_attempt_at),
      truncate(r.spec.title, 40),
    ]),
  );
}

export async function showTask(data_dir: string, id: string): Promise<TaskRecord> {
  const cli = openTasks(data_dir);
  try {
    const record = await cli.manager.get(id);
    if (record === null) throw new CliError("not_found", `task ${id} not found`);
    return record;
  } finally {
    cli.close();
    cli.db.close();
  }
}

export function renderTaskDetail(r: TaskRecord): string {
  const lines = [
    `task:       ${r.id}`,
    `state:      ${r.state} (attempts ${r.attempts}/${r.spec.max_attempts})`,
    `title:      ${r.spec.title}`,
    `session:    ${r.task_session_id}`,
    `parent:     ${r.spec.parent_session_id ?? "(unbound)"}`,
    `subagent:   ${r.subagent_session_id ?? "(none yet)"}`,
    `lease:      ${r.lease_owner ?? "-"}${r.lease_expires_at === null ? "" : ` (expires ${formatTimestamp(r.lease_expires_at)})`}`,
    `created:    ${formatTimestamp(r.created_at)}`,
    `updated:    ${formatTimestamp(r.updated_at)}`,
    `next:       ${r.next_attempt_at === null ? "-" : formatTimestamp(r.next_attempt_at)}`,
    `schedule:   ${r.spec.schedule ?? "-"}`,
  ];
  if (r.last_error !== null) {
    lines.push(`last error: ${r.last_error.name}: ${r.last_error.message}`);
  }
  if (r.result !== null) {
    lines.push(`result:     [${r.result.state}] ${truncate(r.result.summary, 200)}`);
  }
  return lines.join("\n");
}

type Mutation = "pause" | "resume" | "retry" | "cancel";

export async function mutateTask(
  data_dir: string,
  id: string,
  mutation: Mutation,
  actor: string,
): Promise<{ note: string }> {
  const cli = openTasks(data_dir);
  try {
    const before = await cli.manager.get(id);
    if (before === null) throw new CliError("not_found", `task ${id} not found`);
    try {
      await cli.manager[mutation](id);
    } catch (err) {
      const code =
        err instanceof Error && "code" in err ? String((err as { code: unknown }).code) : "unknown";
      const cliCode: "validation_failed" | "not_found" | "runtime_error" =
        code === "not_found"
          ? "not_found"
          : code === "validation_failed"
            ? "validation_failed"
            : "runtime_error";
      throw new CliError(cliCode, err instanceof Error ? err.message : String(err));
    }
    // Cross-process abort insurance: a cancel/pause of a task whose attempt
    // runs in ANOTHER process leaves a control row the owner drains.
    if ((mutation === "cancel" || mutation === "pause") && before.state === "running") {
      const after = await cli.manager.get(id);
      if (after?.subagent_session_id != null) {
        requestSubagentAbort(cli.db, after.subagent_session_id, actor);
      }
    }
    const after = await cli.manager.get(id);
    return { note: `task ${id} → ${after?.state ?? "?"}` };
  } finally {
    cli.close();
    cli.db.close();
  }
}
