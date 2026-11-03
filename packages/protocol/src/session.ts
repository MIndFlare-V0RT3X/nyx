// SPDX-License-Identifier: AGPL-3.0-or-later
// Session store contract: the append-only event log and its projections.

import type { Engagement } from "./scope.js";
import type { Message } from "./content.js";
import type { ApprovalRecord } from "./policy.js";
import type { Usage } from "./util.js";
import type { SessionEvent, StoredEvent } from "./events.js";

export interface SessionMeta {
  session_id: string;
  parent_id: string | null;
  owner_id: string;
  persona_id: string;
  title: string;
  created_at: number;
  updated_at: number;
  engagement: Engagement | null;
}

export interface ToolCallRecord {
  call_id: string;
  turn_id: string;
  name: string;
  input: unknown;
  output: unknown | null;
  status: "pending" | "ok" | "error" | "denied";
  ts: number;
}

export interface Projection {
  session_id: string;
  last_seq: number;
  messages: Message[];
  tool_calls: ToolCallRecord[];
  approvals: ApprovalRecord[];
  usage: Usage;
}

export interface SessionStore {
  create(input: {
    owner_id: string;
    persona_id: string;
    title?: string;
    parent_id?: string;
    engagement?: Engagement | null;
  }): Promise<SessionMeta>;
  /** Appends events, assigning each a monotonic seq, in one transaction. */
  append(session_id: string, events: SessionEvent[]): Promise<StoredEvent[]>;
  read(session_id: string, from_seq?: number, limit?: number): Promise<StoredEvent[]>;
  /** Live tail: replays from from_seq then yields new events as they arrive. */
  stream(session_id: string, from_seq?: number): AsyncIterable<StoredEvent>;
  /** Forks at an inclusive seq boundary; the child's event prefix is identical. */
  fork(session_id: string, at_seq: number): Promise<SessionMeta>;
  meta(session_id: string): Promise<SessionMeta | null>;
  list(opts?: { limit?: number; owner_id?: string }): Promise<SessionMeta[]>;
  projection(session_id: string): Promise<Projection>;
  /** Rebuilds every projection from the event log (replay). */
  rebuildProjections(): Promise<void>;
  close(): void;
}
