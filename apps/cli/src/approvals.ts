// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx approvals` — the operator's out-of-band approval channel: list pending
// approvals (risk, summary, remaining TTL) for one session or across all of
// them, and resolve a pending approval allow/deny. Resolving through this
// path appends the approval.resolved event to the session log through the
// same serialized sink the runtime uses, so the event order stays a total
// order even when the turn itself runs in another process.

import { join } from "node:path";
import { openApprovalEngine } from "@nyx/policy";
import { openSessionStore } from "@nyx/session";
import type {
  ApprovalEngine,
  ApprovalRecord,
  SessionEvent,
  SessionStore,
} from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";
import { CliError } from "./errors.js";
import { formatDuration, truncate } from "./format.js";
import { renderTable } from "./table.js";
import { createEventSink, type EventSink } from "./sink.js";

/** Store + sink + approval engine wired exactly like the runtime's approval leg. */
export interface ApprovalSurface {
  store: SessionStore;
  sink: EventSink;
  approvals: ApprovalEngine;
  close(): void;
}

export function openApprovalSurface(data_dir: string): ApprovalSurface {
  const store = openSessionStore(join(data_dir, "nyx.db"));
  // Same late-bound tool-event audit hook as the runtime: consistent wiring
  // across every surface that opens the sink + approval engine pair.
  let auditEvent: ((event: SessionEvent, seq: number) => void) | undefined;
  const sink = createEventSink(store, {
    onAppended: (stored) => {
      for (const storedEvent of stored) auditEvent?.(storedEvent, storedEvent.seq);
    },
  });
  const handle = openApprovalEngine(join(data_dir, "policy.db"), {
    onCreated: (rec) => {
      void sink
        .append(rec.session_id, [
          {
            type: "approval.requested",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            action_digest: rec.action_digest,
            summary: rec.summary,
            risk: rec.risk,
            ts: Date.now(),
          },
        ])
        .catch(() => undefined);
    },
    onResolved: (rec) => {
      void sink
        .append(rec.session_id, [
          {
            type: "approval.resolved",
            session_id: rec.session_id,
            turn_id: rec.turn_id,
            approval_id: rec.id,
            decision: rec.decision === "pending" ? "deny" : rec.decision,
            decided_by: rec.decided_by ?? "system",
            ts: Date.now(),
          },
        ])
        .catch(() => undefined);
    },
  });
  auditEvent = handle.auditEvent;
  return {
    store,
    sink,
    approvals: handle.engine,
    close: () => {
      store.close();
      handle.close();
    },
  };
}

export interface ApprovalListRow {
  record: ApprovalRecord;
  /** Milliseconds until the 10-minute TTL elapses (<= 0 means expired). */
  ttl_ms: number;
}

/**
 * Pending approvals for one session, or across every session in the store
 * when no session id is given (newest first).
 */
export async function listApprovals(
  data_dir: string,
  session_id?: string,
): Promise<ApprovalListRow[]> {
  const surface = openApprovalSurface(data_dir);
  try {
    const ids =
      session_id !== undefined
        ? [session_id]
        : (await surface.store.list({ limit: 500 })).map((m) => m.session_id);
    const now = Date.now();
    const rows: ApprovalListRow[] = [];
    for (const id of ids) {
      const pending = await surface.approvals.pending(id);
      for (const record of pending) rows.push({ record, ttl_ms: record.expires_at - now });
    }
    rows.sort((a, b) => b.record.created_at - a.record.created_at);
    return rows;
  } finally {
    surface.close();
  }
}

/** Render `nyx approvals list` as a table. */
export function renderApprovalList(rows: readonly ApprovalListRow[]): string {
  return renderTable(
    ["approval", "session", "risk", "ttl", "summary"],
    rows.map((r) => [
      r.record.id,
      r.record.session_id,
      r.record.risk,
      formatDuration(r.ttl_ms),
      truncate(r.record.summary, 72),
    ]),
  );
}

export interface ResolveApprovalOptions {
  data_dir: string;
  id: string;
  decision: "allow" | "deny";
  /** The resolving actor (CLI runs as the owner). */
  decided_by: string;
}

/** Resolve a pending approval; the approval.resolved event lands in the log. */
export async function resolveApproval(opts: ResolveApprovalOptions): Promise<ApprovalRecord> {
  const surface = openApprovalSurface(opts.data_dir);
  try {
    const existing = await surface.approvals.get(opts.id);
    if (existing === null) {
      throw new CliError("not_found", `approval ${opts.id} not found`);
    }
    try {
      return await surface.approvals.resolve(opts.id, opts.decision, opts.decided_by);
    } catch (err) {
      const ser = toSerializedError(err);
      const code = ser.code === "approval_expired" ? "approval_expired" : "approval_denied";
      throw new CliError(code, `${opts.id}: ${ser.message}`, { cause: err });
    }
  } finally {
    // Give the (fire-and-forget) event append a tick to hit the sink before
    // the store closes, so `approvals resolve` persists the resolved event.
    await new Promise((resolve) => setImmediate(resolve));
    surface.close();
  }
}
