// SPDX-License-Identifier: AGPL-3.0-or-later
// The session event vocabulary. The append-only event log is the only source
// of truth; every other table is a projection. `seq` is assigned by the store.

import type { ContentBlock } from "./content.js";
import type { Engagement } from "./scope.js";
import type { CompactionStrategy, SerializedError, Usage } from "./util.js";
import type { RiskTier, ToolOutput } from "./tools.js";
import type { SubagentResult } from "./subagents.js";
import type { TaskSpec } from "./tasks.js";

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
  | {
      type: "message.user";
      session_id: string;
      turn_id: string;
      content: ContentBlock[];
      ts: number;
    }
  | {
      type: "message.assistant";
      session_id: string;
      turn_id: string;
      content: ContentBlock[];
      ts: number;
    }
  | { type: "text.delta"; session_id: string; turn_id: string; text: string; ts: number }
  | { type: "reasoning.delta"; session_id: string; turn_id: string; text: string; ts: number }
  | {
      type: "tool.call";
      session_id: string;
      turn_id: string;
      call_id: string;
      name: string;
      input: unknown;
      ts: number;
    }
  | {
      type: "tool.result";
      session_id: string;
      turn_id: string;
      call_id: string;
      output: ToolOutput;
      ts: number;
    }
  | {
      type: "tool.error";
      session_id: string;
      turn_id: string;
      call_id: string;
      error: SerializedError;
      ts: number;
    }
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
  | {
      type: "compaction.started";
      session_id: string;
      turn_id: string;
      strategy: CompactionStrategy;
      ts: number;
    }
  | {
      type: "compaction.completed";
      session_id: string;
      turn_id: string;
      strategy: CompactionStrategy;
      freed_tokens: number;
      ts: number;
    }
  | { type: "turn.completed"; session_id: string; turn_id: string; usage: Usage; ts: number }
  | { type: "turn.failed"; session_id: string; turn_id: string; error: SerializedError; ts: number }
  | {
      type: "session.forked";
      session_id: string;
      new_session_id: string;
      at_seq: number;
      ts: number;
    }
  // ── Phase 3: subagent lifecycle ──
  // Every subagent.* event is mirrored on BOTH logs: appended to the child's
  // session (session_id = child) and to the parent's session (session_id =
  // parent). `subagent_session_id` identifies the child on the parent's copy;
  // `parent_session_id` is denormalized on the child's copy for query
  // convenience (the child session's parent_id column also carries it).
  | {
      type: "subagent.spawned";
      session_id: string;
      subagent_session_id: string;
      turn_id: string;
      parent_session_id: string;
      parent_turn_id: string;
      task: string;
      depth: number;
      ts: number;
    }
  | {
      type: "subagent.completed";
      session_id: string;
      subagent_session_id: string;
      parent_session_id: string;
      summary: string;
      tokens_used: number;
      duration_ms: number;
      ts: number;
    }
  | {
      type: "subagent.failed";
      session_id: string;
      subagent_session_id: string;
      parent_session_id: string;
      error: SerializedError;
      ts: number;
    }
  | {
      type: "subagent.aborted";
      session_id: string;
      subagent_session_id: string;
      parent_session_id: string;
      reason: string;
      ts: number;
    }
  // ── Phase 4: durable task lifecycle ──
  // Every task.* event is appended to the task's own session log AND (when
  // the task is bound) mirrored onto the parent session's log with
  // session_id = parent. `task_id` identifies the task on both copies.
  | {
      type: "task.created";
      session_id: string;
      task_id: string;
      title: string;
      spec: TaskSpec;
      ts: number;
    }
  | {
      type: "task.started";
      session_id: string;
      task_id: string;
      attempt: number;
      subagent_session_id: string | null;
      ts: number;
    }
  | {
      type: "task.completed";
      session_id: string;
      task_id: string;
      result: SubagentResult | null;
      attempts: number;
      ts: number;
    }
  | {
      type: "task.failed";
      session_id: string;
      task_id: string;
      error: SerializedError;
      attempts: number;
      ts: number;
    }
  | {
      type: "task.paused";
      session_id: string;
      task_id: string;
      ts: number;
    }
  | {
      type: "task.resumed";
      session_id: string;
      task_id: string;
      ts: number;
    }
  | {
      type: "task.cancelled";
      session_id: string;
      task_id: string;
      ts: number;
    }
  | {
      type: "task.retrying";
      session_id: string;
      task_id: string;
      attempt: number;
      next_attempt_at: number;
      error: SerializedError;
      ts: number;
    }
  /**
   * Phase 4 §4.4 (recorded deviation from the protocol freeze — the Phase 4
   * brief mandates this event): a session loaded a skill's body through the
   * load_skill tool. Progressive disclosure, on the record.
   */
  | {
      type: "skill.loaded";
      session_id: string;
      name: string;
      version: string | null;
      ts: number;
    };

/** An event as stored: the caller's payload plus the store-assigned seq. */
export type StoredEvent = SessionEvent & { seq: number };
