// SPDX-License-Identifier: AGPL-3.0-or-later
// The session event vocabulary. The append-only event log is the only source
// of truth; every other table is a projection. `seq` is assigned by the store.

import type { ContentBlock } from "./content.js";
import type { Engagement } from "./scope.js";
import type { CompactionStrategy, SerializedError, Usage } from "./util.js";
import type { RiskTier, ToolOutput } from "./tools.js";

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
  | { type: "compaction.started"; session_id: string; turn_id: string; strategy: CompactionStrategy; ts: number }
  | { type: "compaction.completed"; session_id: string; turn_id: string; strategy: CompactionStrategy; freed_tokens: number; ts: number }
  | { type: "turn.completed"; session_id: string; turn_id: string; usage: Usage; ts: number }
  | { type: "turn.failed"; session_id: string; turn_id: string; error: SerializedError; ts: number }
  | { type: "session.forked"; session_id: string; new_session_id: string; at_seq: number; ts: number };

/** An event as stored: the caller's payload plus the store-assigned seq. */
export type StoredEvent = SessionEvent & { seq: number };
