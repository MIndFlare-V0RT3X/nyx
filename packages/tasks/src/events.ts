// SPDX-License-Identifier: AGPL-3.0-or-later
// Task-event mirroring (§2.1.6): a task.* event lands on the task's own
// session log, and — when the task is bound to a parent session — a mirrored
// copy lands on the parent's log. The task's own log is the record of truth;
// the parent copy is a notification whose failure never breaks bookkeeping.

import type { SessionEvent, SessionStore, TaskRecord } from "@nyx/protocol";

export async function emitTaskEvent(
  store: SessionStore,
  record: Pick<TaskRecord, "task_session_id" | "spec">,
  event: SessionEvent,
): Promise<void> {
  await store.append(record.task_session_id, [event]);
  const parent = record.spec.parent_session_id;
  if (parent !== undefined && parent !== record.task_session_id) {
    try {
      await store.append(parent, [{ ...event, session_id: parent } as SessionEvent]);
    } catch {
      // An archived/deleted parent log must not fail the task's own record.
    }
  }
}
