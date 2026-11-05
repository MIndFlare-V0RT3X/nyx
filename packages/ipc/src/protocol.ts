// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.3 — the kernel-socket protocol: a versioned, token-authenticated
// JSON-RPC surface over a unix socket. This is the NARROWER version of the
// in-process interfaces the single-process build uses directly: the request
// vocabulary is exactly what the split runtime exercises, nothing more.
//
// Wire format: NDJSON frames (one JSON object per line). Frame order:
//
//   client → server : {"v":1,"auth":"Bearer <token>","role":"agent"}   handshake
//   server → client : {"ok":true,"server_version":"..."}               | or
//                     {"ok":false,"error":{"code":"auth"}} + close     |
//   client → server : {"id":1,"request":{...}}                         request
//   server → client : {"id":1,"response":{"ok":true,"result":...}}     |
//                     {"id":1,"response":{"ok":false,"error":{...}}}   |
//
// Rules:
//   · The handshake is mandatory and must be the FIRST frame; anything
//     before it (or a bad token) destroys the socket with no response —
//     a probe learns nothing but that it failed.
//   · `v` must match the server's IPC_PROTOCOL_VERSION exactly; a mismatch
//     negotiates nothing — it refuses (each side was built for a different
//     protocol and must not guess at the other's shapes).
//   · Requests are correlated by `id`; there is no notification channel and
//     no server-initiated traffic (Phase 7 keeps the boundary synchronous:
//     events flow back inside responses, preserving event order).

import type {
  ActionRequest,
  ApprovalContext,
  ApprovalRecord,
  Engagement,
  MemoryEntry,
  PolicyVerdict,
  Projection,
  SessionEvent,
  SessionMeta,
  StoredEvent,
  ToolOutput,
  ToolSchema,
} from "@nyx/protocol";

/** Bump on any wire-incompatible change. Both sides must agree exactly. */
export const IPC_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Requests (kernel socket)
// ---------------------------------------------------------------------------

export type SessionCreateInput = {
  owner_id: string;
  persona_id: string;
  title?: string;
  parent_id?: string;
  engagement?: Engagement | null;
};

export type KernelRequest =
  | { type: "health.ping" }
  | { type: "session.create"; input: SessionCreateInput }
  | { type: "session.append"; session_id: string; events: SessionEvent[] }
  | { type: "session.read"; session_id: string; from_seq?: number; limit?: number }
  | { type: "session.meta"; session_id: string }
  | { type: "session.projection"; session_id: string }
  | { type: "policy.evaluate"; action: ActionRequest }
  | { type: "approval.request"; verdict: PolicyVerdict; context: ApprovalContext }
  | { type: "approval.resolve"; id: string; decision: "allow" | "deny"; decided_by: string }
  | { type: "approval.pending"; session_id: string }
  /** The kernel is the only process that reads credential env vars. A tool
   *  (or provider construction) that needs one gets a scoped, TTL-60s,
   *  single-use token — the durable value never crosses the boundary. */
  | { type: "credential.inject"; name: string; target_env: string }
  | { type: "audit.write"; entry: { actor: string; action: string; payload: unknown } }
  | { type: "memory.write"; entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at"> }
  | { type: "memory.list"; scopes?: string[]; limit?: number }
  | { type: "memory.search"; query: string; limit?: number };

export type KernelRequestResult =
  | { type: "health.ping"; result: { ok: true; uptime_ms: number; process_mode: string } }
  | { type: "session.create"; result: SessionMeta }
  | { type: "session.append"; result: StoredEvent[] }
  | { type: "session.read"; result: StoredEvent[] }
  | { type: "session.meta"; result: SessionMeta | null }
  | { type: "session.projection"; result: Projection }
  | { type: "policy.evaluate"; result: PolicyVerdict }
  | { type: "approval.request"; result: "allow" | "deny" }
  | { type: "approval.resolve"; result: ApprovalRecord }
  | { type: "approval.pending"; result: ApprovalRecord[] }
  | {
      type: "credential.inject";
      result: { token: string; target_env: string; expires_at: number; scopes: string[] };
    }
  | { type: "audit.write"; result: { ok: true } }
  | { type: "memory.write"; result: MemoryEntry }
  | { type: "memory.list"; result: MemoryEntry[] }
  | { type: "memory.search"; result: MemoryEntry[] };

// ---------------------------------------------------------------------------
// Requests (tools socket — the agent runtime calls tool execution here)
// ---------------------------------------------------------------------------

export type ToolExecuteRequest = {
  type: "tool.execute";
  call: { call_id: string; name: string; input: Record<string, unknown> };
  /** Everything the runtime needs that lives in the TOOLS process: the
   *  sandbox spec (provisioned there), the engagement snapshot (scope), and
   *  the turn identity (event attribution). */
  context: {
    session_id: string;
    turn_id: string;
    engagement: Engagement | null;
    workdir_root: string;
  };
  /** force_ask mirrors the runtime's hook-veto path (single mode parity). */
  force_ask?: boolean;
};

export type ToolExecuteResult = {
  /** The tool.call / tool.result / tool.error / action.denied events, in
   *  order, exactly as the single-process runtime's pump would have emitted
   *  them — the agent appends them to the session log before yielding. */
  events: SessionEvent[];
  output: ToolOutput | null;
};

export type ToolsRequest =
  | { type: "health.ping" }
  | { type: "tools.specs" }
  | { type: "tools.list" }
  | ToolExecuteRequest
  | { type: "env.probe"; keys: string[] };

export type ToolsRequestResult =
  | { type: "health.ping"; result: { ok: true; uptime_ms: number; process_mode: string } }
  | { type: "tools.specs"; result: ToolSchema[] }
  | { type: "tools.list"; result: { name: string; risk: string; capabilities: string[] }[] }
  | { type: "tool.execute"; result: ToolExecuteResult }
  | { type: "env.probe"; result: { present: string[]; absent: string[] } };

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

export interface HandshakeFrame {
  v: number;
  auth: string;
  role: "kernel-client" | "agent" | "tools";
}

export interface HandshakeOk {
  ok: true;
  server_version: string;
}

export interface HandshakeDenied {
  ok: false;
  error: { code: "auth" | "version"; message: string };
}

export type HandshakeResponse = HandshakeOk | HandshakeDenied;

export interface RequestFrame {
  id: number;
  request: KernelRequest | ToolsRequest;
}

export type IpcError = {
  code:
    | "ipc_closed"
    | "ipc_timeout"
    | "ipc_malformed"
    | "auth"
    | "version"
    | "not_found"
    | "validation_failed"
    | "not_implemented"
    | "internal";
  message: string;
  /** Server-side hint for retryable conditions (e.g. busy db). */
  retry_after_ms?: number;
};

export type IpcResponse = { ok: true; result: unknown } | { ok: false; error: IpcError };

export interface ResponseFrame {
  id: number;
  response: IpcResponse;
}
