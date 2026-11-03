// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx sessions` — read-only projections over the session store, rendered as
// tables: list (id, title, turns, updated), show (messages + tool-call
// summary + approvals + usage, or the raw event log with --events), fork
// (child session id).

import { openSessionStore } from "@nyx/session";
import type {
  Projection,
  SessionMeta,
  SessionStore,
  StoredEvent,
} from "@nyx/protocol";
import { CliError } from "./errors.js";
import { formatTimestamp, truncate } from "./format.js";
import { renderTable } from "./table.js";

export interface SessionRow {
  session_id: string;
  title: string;
  turns: number;
  updated_at: number;
}

/** Load session rows (id, title, turns, updated) — turns counted from projections. */
export async function listSessions(data_dir: string, limit = 50): Promise<SessionRow[]> {
  const store = openSessionStore(`${data_dir}/nyx.db`);
  try {
    const metas = await store.list({ limit });
    const rows: SessionRow[] = [];
    for (const meta of metas) {
      const projection = await store.projection(meta.session_id);
      rows.push({
        session_id: meta.session_id,
        title: meta.title,
        turns: projection.messages.filter((m) => m.role === "user").length,
        updated_at: meta.updated_at,
      });
    }
    return rows;
  } finally {
    store.close();
  }
}

/** Render `nyx sessions list` as a table. */
export function renderSessionList(rows: readonly SessionRow[]): string {
  return renderTable(
    ["session", "title", "turns", "updated"],
    rows.map((r) => [r.session_id, truncate(r.title, 40), String(r.turns), formatTimestamp(r.updated_at)]),
  );
}

export interface SessionDetail {
  meta: SessionMeta;
  projection: Projection;
  events: StoredEvent[];
}

async function openOrThrow(store: SessionStore, id: string): Promise<SessionMeta> {
  const meta = await store.meta(id);
  if (meta === null) throw new CliError("not_found", `session ${id} not found`);
  return meta;
}

/** Load one session's full detail: meta, projection, raw events. */
export async function showSession(data_dir: string, id: string): Promise<SessionDetail> {
  const store = openSessionStore(`${data_dir}/nyx.db`);
  try {
    const meta = await openOrThrow(store, id);
    const [projection, events] = await Promise.all([store.projection(id), store.read(id)]);
    return { meta, projection, events };
  } finally {
    store.close();
  }
}

function messageText(content: ReadonlyArray<{ type: string; text?: string }>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** Render `nyx sessions show <id>`: meta + messages + tool calls + approvals + usage. */
export function renderSessionDetail(detail: SessionDetail): string {
  const { meta, projection } = detail;
  const out: string[] = [];
  out.push(`session   ${meta.session_id}`);
  out.push(`persona   ${meta.persona_id}`);
  out.push(`owner     ${meta.owner_id}`);
  if (meta.parent_id !== null) out.push(`forked-of ${meta.parent_id}`);
  out.push(`title     ${meta.title}`);
  out.push(`created   ${formatTimestamp(meta.created_at)}`);
  out.push(`updated   ${formatTimestamp(meta.updated_at)}`);
  if (meta.engagement !== null) {
    out.push(`engagement ${meta.engagement.id} (expires ${formatTimestamp(meta.engagement.expires_at)})`);
  }
  out.push("");
  out.push("messages");
  if (projection.messages.length === 0) {
    out.push("  (none)");
  } else {
    for (const message of projection.messages) {
      out.push(`  [${message.role}] ${truncate(messageText(message.content).trim(), 100)}`);
    }
  }
  out.push("");
  out.push("tool calls");
  if (projection.tool_calls.length === 0) {
    out.push("  (none)");
  } else {
    out.push(
      renderTable(
        ["call", "tool", "status", "ts"],
        projection.tool_calls.map((c) => [
          c.call_id,
          c.name,
          c.status,
          formatTimestamp(c.ts),
        ]),
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
  out.push("");
  out.push("approvals");
  if (projection.approvals.length === 0) {
    out.push("  (none)");
  } else {
    out.push(
      renderTable(
        ["approval", "risk", "decision", "decided_by"],
        projection.approvals.map((a) => [a.id, a.risk, a.decision, a.decided_by ?? "—"]),
      )
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    );
  }
  const usage = projection.usage;
  out.push("");
  out.push(
    `usage     in ${usage.input_tokens}, out ${usage.output_tokens}, total ${usage.total_tokens ?? usage.input_tokens + usage.output_tokens}`,
  );
  return out.join("\n");
}

/** Render `nyx sessions show <id> --events`: the raw event log. */
export function renderSessionEvents(detail: SessionDetail): string {
  const out: string[] = [];
  for (const event of detail.events) {
    const detailField = (() => {
      switch (event.type) {
        case "text.delta":
        case "reasoning.delta":
          return truncate(event.text, 60);
        case "message.user":
        case "message.assistant":
          return truncate(messageText(event.content).trim(), 60);
        case "tool.call":
          return `${event.name} ${truncate(JSON.stringify(event.input) ?? "", 50)}`;
        case "tool.result":
          return event.call_id;
        case "tool.error":
          return `${event.call_id}: ${truncate(event.error.message, 50)}`;
        case "action.denied":
          return `${event.call_id}: ${event.reason}`;
        case "approval.requested":
          return `${event.approval_id} ${truncate(event.summary, 50)}`;
        case "approval.resolved":
          return `${event.approval_id} ${event.decision} by ${event.decided_by}`;
        case "turn.completed":
          return `in ${event.usage.input_tokens} / out ${event.usage.output_tokens}`;
        case "turn.failed":
          return truncate(event.error.message, 60);
        default:
          return "";
      }
    })();
    out.push(`${String(event.seq).padStart(6)}  ${event.type.padEnd(20)} ${formatTimestamp(event.ts)}  ${detailField}`);
  }
  return out.length > 0 ? out.join("\n") : "(no events)";
}

/** Fork a session at an inclusive seq boundary; returns the child meta. */
export async function forkSession(data_dir: string, id: string, at_seq: number): Promise<SessionMeta> {
  const store = openSessionStore(`${data_dir}/nyx.db`);
  try {
    await openOrThrow(store, id);
    if (!Number.isInteger(at_seq) || at_seq < 1) {
      throw new CliError("validation_failed", `at_seq must be a positive integer, got ${at_seq}`);
    }
    const events = await store.read(id);
    const last = events.length > 0 ? events[events.length - 1] : undefined;
    if (last !== undefined && at_seq > last.seq) {
      throw new CliError(
        "validation_failed",
        `at_seq ${at_seq} is past the session's last event (seq ${last.seq})`,
      );
    }
    try {
      return await store.fork(id, at_seq);
    } catch (err) {
      throw new CliError("validation_failed", err instanceof Error ? err.message : String(err));
    }
  } finally {
    store.close();
  }
}
