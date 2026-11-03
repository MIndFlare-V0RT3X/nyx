// SPDX-License-Identifier: AGPL-3.0-or-later
// Wire shapes spoken by the NYX server (docs/PROTOCOL.md). Mirrored locally
// as type-only definitions so the browser bundle carries no workspace
// dependency; these must stay structurally identical to @nyx/protocol.

export type RiskTier = "R0" | "R1" | "R2" | "R3" | "R4";

export type ToolOutput =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  | { kind: "file"; path: string; bytes: number; mime: string }
  | { kind: "artifact"; artifact_id: string; path: string; bytes: number };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data_base64: string }
  | { type: "tool_use"; call_id: string; name: string; input: unknown }
  | { type: "tool_result"; call_id: string; output: ToolOutput }
  | { type: "reasoning"; text: string; encrypted?: string };

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: ContentBlock[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  retryable?: boolean;
}

export interface ScopeTargets {
  cidrs: string[];
  domains: string[];
  ports?: { allow?: number[]; deny?: number[] };
  exclude?: { cidrs?: string[]; domains?: string[] };
}

export interface Engagement {
  id: string;
  title?: string;
  operator_id: string;
  authorized_at: number;
  expires_at: number;
  targets: ScopeTargets;
  rules?: string[];
}

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

export interface ApprovalRecord {
  id: string;
  session_id: string;
  turn_id: string;
  action_digest: string;
  summary: string;
  risk: RiskTier;
  decision: "pending" | "allow" | "deny";
  decided_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export interface Projection {
  session_id: string;
  last_seq: number;
  messages: Message[];
  tool_calls: ToolCallRecord[];
  approvals: ApprovalRecord[];
  usage: Usage;
}

export type SessionEvent =
  | {
      type: "session.created";
      session_id: string;
      owner_id: string;
      persona_id: string;
      parent_id: string | null;
      engagement: Engagement | null;
      ts: number;
    }
  | { type: "turn.started"; session_id: string; turn_id: string; ts: number }
  | { type: "message.user"; session_id: string; turn_id: string; content: ContentBlock[]; ts: number }
  | { type: "message.assistant"; session_id: string; turn_id: string; content: ContentBlock[]; ts: number }
  | { type: "text.delta"; session_id: string; turn_id: string; text: string; ts: number }
  | { type: "reasoning.delta"; session_id: string; turn_id: string; text: string; ts: number }
  | { type: "tool.call"; session_id: string; turn_id: string; call_id: string; name: string; input: unknown; ts: number }
  | { type: "tool.result"; session_id: string; turn_id: string; call_id: string; output: ToolOutput; ts: number }
  | { type: "tool.error"; session_id: string; turn_id: string; call_id: string; error: SerializedError; ts: number }
  | {
      type: "action.denied";
      session_id: string;
      turn_id: string;
      call_id: string;
      reason: "policy" | "approval" | "scope";
      detail: string;
      rule_id?: string;
      ts: number;
    }
  | {
      type: "approval.requested";
      session_id: string;
      turn_id: string;
      approval_id: string;
      action_digest: string;
      summary: string;
      risk: RiskTier;
      ts: number;
    }
  | {
      type: "approval.resolved";
      session_id: string;
      turn_id: string;
      approval_id: string;
      decision: "allow" | "deny";
      decided_by: string;
      ts: number;
    }
  | { type: "compaction.started"; session_id: string; turn_id: string; strategy: string; ts: number }
  | { type: "compaction.completed"; session_id: string; turn_id: string; strategy: string; freed_tokens: number; ts: number }
  | { type: "turn.completed"; session_id: string; turn_id: string; usage: Usage; ts: number }
  | { type: "turn.failed"; session_id: string; turn_id: string; error: SerializedError; ts: number }
  | { type: "session.forked"; session_id: string; new_session_id: string; at_seq: number; ts: number };

/** An event as stored: the payload plus the store-assigned seq. */
export type StoredEvent = SessionEvent & { seq: number };
