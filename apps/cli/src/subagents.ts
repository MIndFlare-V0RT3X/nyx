// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx subagents` — list a parent session's subagent children and abort a
// running one. Both commands run in a SEPARATE process from whatever spawned
// the child (server, `nyx chat`), so abort is delivered through the
// subagent_abort_requests table in nyx.db — the owning process's manager
// drains it on its poll (the same cross-process pattern the approval engine
// uses). Listing is read-only over the event log: restart-safe, reconstructed
// from the mirrored subagent.* events.

import { createSubagentManager } from "@nyx/subagents";
import type { SubagentInfo } from "@nyx/protocol";
import { openSessionStore } from "@nyx/session";
import { CliError } from "./errors.js";
import { formatTimestamp, truncate } from "./format.js";
import { renderTable } from "./table.js";

/** List the subagent children of a session (kind, state, task). */
export async function listSubagents(data_dir: string, parent_id: string): Promise<SubagentInfo[]> {
  const store = openSessionStore(`${data_dir}/nyx.db`);
  try {
    const meta = await store.meta(parent_id);
    if (meta === null) throw new CliError("not_found", `session ${parent_id} not found`);
    const manager = createSubagentManager({ store });
    return await manager.list(parent_id);
  } finally {
    store.close();
  }
}

/** Render `nyx subagents list` as a table. */
export function renderSubagentList(infos: readonly SubagentInfo[]): string {
  if (infos.length === 0) return "(no subagents)";
  return renderTable(
    ["subagent", "state", "spawned", "turn", "task"],
    infos.map((i) => [
      i.session_id,
      i.state,
      formatTimestamp(i.spawned_at),
      i.parent_turn_id,
      truncate(i.task, 48),
    ]),
  );
}

/**
 * Abort a running subagent. Returns a human-readable outcome: the child is
 * either still running (abort requested via the control table — the owning
 * process picks it up within its poll interval) or already settled (no-op).
 */
export async function abortSubagent(
  data_dir: string,
  child_id: string,
  actor: string,
): Promise<{ requested: boolean; note: string }> {
  const store = openSessionStore(`${data_dir}/nyx.db`);
  try {
    const meta = await store.meta(child_id);
    if (meta === null) throw new CliError("not_found", `session ${child_id} not found`);
    if (meta.kind !== "subagent") {
      throw new CliError("validation_failed", `session ${child_id} is not a subagent session`);
    }
    if (meta.archived_at !== null) {
      return { requested: false, note: `subagent ${child_id} is archived` };
    }
    const events = await store.read(child_id);
    const settled = events.some(
      (e) =>
        e.type === "subagent.completed" || e.type === "subagent.failed" || e.type === "subagent.aborted",
    );
    if (settled) {
      return {
        requested: false,
        note: `subagent ${child_id} is not running (already settled)`,
      };
    }
    // Running: leave the control row on the shared nyx.db handle. Opening a
    // second handle to the same file is safe (WAL + busy_timeout).
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(`${data_dir}/nyx.db`);
    try {
      db.pragma("busy_timeout = 5000");
      const { requestSubagentAbort } = await import("@nyx/subagents");
      requestSubagentAbort(db, child_id, actor);
    } finally {
      db.close();
    }
    return {
      requested: true,
      note: `abort requested for subagent ${child_id} (the owning process applies it within its poll interval)`,
    };
  } finally {
    store.close();
  }
}
