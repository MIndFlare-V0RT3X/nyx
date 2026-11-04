// SPDX-License-Identifier: AGPL-3.0-or-later
// Session-event audit: tool executions and denials land in the hash-chained
// audit log with an event_seq cross-reference, so an operator can prove not
// only what they approved but what the agent actually did. The audit row is
// written by the app-layer EventSink immediately after the store assigns the
// event's seq, inside the sink's serialized append chain (single-writer,
// ordered). The event log and the audit log are separate SQLite databases, so
// the two writes are not one ACID transaction; the residual (a crash between
// event append and audit append leaves an event without an audit row) is
// detectable — reconcileEventAudit reports exactly that.

import type { SessionEvent, StoredEvent } from "@nyx/protocol";
import { appendAudit } from "./audit.js";
import type Database from "better-sqlite3";

/** Event types whose occurrence must be audited. */
export type AuditableEventType = "tool.call" | "tool.result" | "tool.error" | "action.denied";

export type AuditableEvent = Extract<SessionEvent, { type: AuditableEventType }>;

export function isAuditableEvent(event: SessionEvent): event is AuditableEvent {
  return (
    event.type === "tool.call" ||
    event.type === "tool.result" ||
    event.type === "tool.error" ||
    event.type === "action.denied"
  );
}

function payloadOf(event: AuditableEvent): Record<string, unknown> {
  const base: Record<string, unknown> = {
    session_id: event.session_id,
    turn_id: event.turn_id,
    call_id: event.call_id,
  };
  switch (event.type) {
    case "tool.call":
      return { ...base, name: event.name, input: event.input };
    case "tool.result":
      return { ...base, output: event.output };
    case "tool.error":
      return { ...base, error: event.error };
    case "action.denied":
      return { ...base, reason: event.reason, detail: event.detail };
  }
}

/**
 * Append the audit row for one stored session event. No-op for event types
 * that are not audited (approvals audit themselves in @nyx/policy's approval
 * engine; lifecycle events stay in the event log only).
 */
export function appendEventAudit(
  db: Database.Database,
  event: SessionEvent,
  seq: number,
  opts: { now?: () => number } = {},
): void {
  if (!isAuditableEvent(event)) return;
  appendAudit(
    db,
    {
      actor: event.type === "action.denied" ? "system:runtime" : "agent",
      action: event.type,
      payload: payloadOf(event),
      event_seq: seq,
    },
    opts,
  );
}

interface AuditLinkRow {
  id: number;
  action: string;
  event_seq: number;
}

/**
 * Cross-check the audit log against the session event log. Returns a list of
 * human-readable problems; empty means every auditable event has exactly one
 * audit row with a matching action and event_seq, and every event-referencing
 * audit row points at a real auditable event.
 */
export function reconcileEventAudit(
  db: Database.Database,
  events: Array<StoredEvent | (SessionEvent & { seq: number })>,
): string[] {
  const rows = db
    .prepare(
      "SELECT id, action, event_seq FROM audit WHERE event_seq IS NOT NULL ORDER BY event_seq, id",
    )
    .all() as AuditLinkRow[];
  const bySeq = new Map<number, AuditLinkRow[]>();
  for (const row of rows) {
    const list = bySeq.get(row.event_seq) ?? [];
    list.push(row);
    bySeq.set(row.event_seq, list);
  }

  const problems: string[] = [];
  const auditableSeqs = new Set<number>();
  for (const event of events) {
    if (!isAuditableEvent(event)) continue;
    auditableSeqs.add(event.seq);
    const found = bySeq.get(event.seq) ?? [];
    if (found.length === 0) {
      problems.push(`no audit row for ${event.type} event at seq ${event.seq}`);
    } else if (found.length > 1) {
      problems.push(`${found.length} audit rows reference event seq ${event.seq} (expected 1)`);
    } else if (found[0]!.action !== event.type) {
      problems.push(
        `audit row ${found[0]!.id} action "${found[0]!.action}" does not match ` +
          `event type "${event.type}" at seq ${event.seq}`,
      );
    }
  }
  for (const [seq, found] of bySeq) {
    if (!auditableSeqs.has(seq)) {
      problems.push(`audit row(s) ${found.map((r) => r.id).join(",")} reference seq ${seq}, which is not an auditable event`);
    }
  }
  return problems;
}
