// SPDX-License-Identifier: AGPL-3.0-or-later
// Projection maintenance: derives `messages`, `tool_calls`, `approvals` and
// `projection_version` rows from stored events. Every derived value is a pure
// function of the event payload plus its seq — no clocks, no randomness — so
// an incremental apply and a full rebuild produce byte-identical tables.
//
// Row id convention (other packages depend on this): projection rows are
// keyed `${session_id}:${natural_id}` where natural_id is the event's seq
// (messages), call_id (tool_calls) or approval_id (approvals). This keeps ids
// unique when a fork re-appends another session's events under a new
// session_id, and keeps them deterministic for replay.

import type Database from "better-sqlite3";
import { canonicalJson } from "@nyx/protocol";
import type { StoredEvent } from "@nyx/protocol";

/** Approvals expire 10 minutes after creation (protocol contract). */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

type SqliteStatement = Database.Statement<unknown[], unknown>;

export interface ProjectionStatements {
  insertMessage: SqliteStatement;
  insertToolCall: SqliteStatement;
  updateToolCall: SqliteStatement;
  upsertApproval: SqliteStatement;
  resolveApproval: SqliteStatement;
  trackProjection: SqliteStatement;
}

export function compositeId(sessionId: string, key: string | number): string {
  return `${sessionId}:${key}`;
}

export function prepareProjectionStatements(db: Database.Database): ProjectionStatements {
  return {
    // Only message.user / message.assistant events create rows; deltas do not.
    insertMessage: db.prepare(
      "INSERT INTO messages (id, session_id, turn_id, seq, role, content_json, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ),
    insertToolCall: db.prepare(
      "INSERT INTO tool_calls (id, session_id, turn_id, seq, name, input_json, output_json, status, ts) " +
        "VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', ?)",
    ),
    updateToolCall: db.prepare("UPDATE tool_calls SET status = ?, output_json = ? WHERE id = ?"),
    // Upsert so an event always wins over any pre-existing row (e.g. one the
    // policy engine created before the approval.requested event landed).
    upsertApproval: db.prepare(
      "INSERT INTO approvals (id, session_id, turn_id, action_digest, summary, risk, decision, decided_by, created_at, expires_at, used_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL) " +
        "ON CONFLICT(id) DO UPDATE SET " +
        "turn_id = excluded.turn_id, action_digest = excluded.action_digest, summary = excluded.summary, " +
        "risk = excluded.risk, decision = 'pending', decided_by = NULL, " +
        "created_at = excluded.created_at, expires_at = excluded.expires_at",
    ),
    resolveApproval: db.prepare("UPDATE approvals SET decision = ?, decided_by = ? WHERE id = ?"),
    trackProjection: db.prepare(
      "INSERT INTO projection_version (name, last_seq) VALUES (?, ?) " +
        "ON CONFLICT(name) DO UPDATE SET last_seq = excluded.last_seq",
    ),
  };
}

/**
 * Applies one stored event to the projection tables. Must run inside the same
 * transaction as the event insert. `seq` must be the event's final seq.
 */
export function applyProjectionEvent(stmts: ProjectionStatements, ev: StoredEvent): void {
  switch (ev.type) {
    case "message.user":
    case "message.assistant": {
      const role = ev.type === "message.user" ? "user" : "assistant";
      stmts.insertMessage.run(
        compositeId(ev.session_id, ev.seq),
        ev.session_id,
        ev.turn_id,
        ev.seq,
        role,
        canonicalJson(ev.content),
        ev.ts,
      );
      break;
    }
    case "tool.call":
      stmts.insertToolCall.run(
        compositeId(ev.session_id, ev.call_id),
        ev.session_id,
        ev.turn_id,
        ev.seq,
        ev.name,
        canonicalJson(ev.input),
        ev.ts,
      );
      break;
    case "tool.result":
      stmts.updateToolCall.run(
        "ok",
        canonicalJson(ev.output),
        compositeId(ev.session_id, ev.call_id),
      );
      break;
    case "tool.error":
      stmts.updateToolCall.run("error", null, compositeId(ev.session_id, ev.call_id));
      break;
    case "action.denied":
      stmts.updateToolCall.run("denied", null, compositeId(ev.session_id, ev.call_id));
      break;
    case "approval.requested":
      stmts.upsertApproval.run(
        compositeId(ev.session_id, ev.approval_id),
        ev.session_id,
        ev.turn_id,
        ev.action_digest,
        ev.summary,
        ev.risk,
        ev.ts,
        ev.ts + APPROVAL_TTL_MS,
      );
      break;
    case "approval.resolved":
      stmts.resolveApproval.run(
        ev.decision,
        ev.decided_by,
        compositeId(ev.session_id, ev.approval_id),
      );
      break;
    default:
      // turn.started/completed/failed, deltas, compaction.*, session.* carry
      // no projection state beyond last_seq tracking below.
      break;
  }
  stmts.trackProjection.run(ev.session_id, ev.seq);
}
