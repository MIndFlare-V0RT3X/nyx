// SPDX-License-Identifier: AGPL-3.0-or-later
// The chat TUI's pure state machine: every session event and every operator
// input maps to a state transition, with no React and no I/O. The Ink view
// (chat.tsx) is a thin renderer over this state; the headless chat driver
// (chat-driver.ts) drives the same transitions — which is exactly how the
// TUI is tested (ink 5.x ships no testing-library, so the harness runs the
// driver without a terminal).

import { APPROVAL_TTL_MS } from "@nyx/session";
import type { ApprovalRecord, SessionEvent, Usage } from "@nyx/protocol";
import { mergeUsage } from "@nyx/protocol";
import { compactJson, describeToolOutput, formatUsage, truncate } from "./format.js";

export type ChatEntryKind =
  | "user"
  | "assistant"
  | "tool"
  | "denial"
  | "approval"
  | "error"
  | "info";

export interface ChatEntry {
  kind: ChatEntryKind;
  text: string;
}

export interface ChatApprovalItem {
  id: string;
  summary: string;
  risk: string;
  expires_at: number;
}

export interface ChatState {
  session_id: string;
  persona_id: string;
  /** Rendered transcript (user/assistant/tool/approval/info lines). */
  entries: ChatEntry[];
  /** In-flight assistant text (deltas are not stored, so we buffer live). */
  streaming: string;
  /** A turn is currently executing. */
  running: boolean;
  /** Pending approvals, newest last. */
  pending: ChatApprovalItem[];
  /** Index into `pending` the y/n keys act on. */
  selected: number;
  /** Last turn's usage, rendered. */
  usage: string | null;
  /** Summed usage across turns. */
  total_usage: Usage;
  /** The input box content. */
  input: string;
  exit_requested: boolean;
  /** Transient one-line notice (errors, busy signals). */
  notice: string | null;
  /** call_id → tool name, for closing transcript lines. */
  call_names: Record<string, string>;
}

export function initialChatState(session: { session_id: string; persona_id: string }): ChatState {
  return {
    session_id: session.session_id,
    persona_id: session.persona_id,
    entries: [],
    streaming: "",
    running: false,
    pending: [],
    selected: 0,
    usage: null,
    total_usage: mergeUsage(),
    input: "",
    exit_requested: false,
    notice: null,
    call_names: {},
  };
}

function withEntry(state: ChatState, kind: ChatEntryKind, text: string): ChatState {
  if (text === "") return state;
  return { ...state, entries: [...state.entries, { kind, text }] };
}

/**
 * Fold one session event into the chat state (pure). Approval events arrive
 * here too — through the driver's approval callback, never the loop iterator
 * — so both paths share one transition function.
 */
export function applyEventToChat(state: ChatState, event: SessionEvent): ChatState {
  switch (event.type) {
    case "turn.started":
      return { ...state, running: true };
    case "message.user":
      return withEntry(
        state,
        "user",
        event.content
          .filter((b) => b.type === "text")
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("\n"),
      );
    case "text.delta":
      return { ...state, streaming: state.streaming + event.text };
    case "message.assistant": {
      // The loop appends the assistant message after streaming; keep the
      // buffered deltas (they are what the operator watched live).
      if (state.streaming.length > 0) {
        return withEntry({ ...state, streaming: "" }, "assistant", state.streaming);
      }
      const text = event.content
        .filter((b) => b.type === "text")
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("\n");
      return withEntry(state, "assistant", text);
    }
    case "tool.call": {
      const call_names = { ...state.call_names, [event.call_id]: event.name };
      return withEntry(
        { ...state, call_names },
        "tool",
        `→ ${event.name} ${truncate(compactJson(event.input), 120)}`,
      );
    }
    case "tool.result":
      return withEntry(
        state,
        "tool",
        `✓ ${state.call_names[event.call_id] ?? event.call_id} ${describeToolOutput(event.output)}`,
      );
    case "tool.error":
      return withEntry(
        state,
        "tool",
        `✗ ${state.call_names[event.call_id] ?? event.call_id}: ${event.error.message}`,
      );
    case "action.denied":
      return withEntry(
        state,
        "denial",
        `✗ ${state.call_names[event.call_id] ?? event.call_id}: denied (${event.reason}) ${truncate(event.detail, 100)}`,
      );
    case "approval.requested":
      return applyApprovalRecord(state, {
        id: event.approval_id,
        summary: event.summary,
        risk: event.risk,
        // The event carries no expires_at; the engine's TTL is a protocol
        // constant, and ts is the creation moment, so derive it.
        expires_at: event.ts + APPROVAL_TTL_MS,
      });
    case "approval.resolved": {
      const pending = state.pending.filter((a) => a.id !== event.approval_id);
      return withEntry(
        {
          ...state,
          pending,
          selected: Math.min(state.selected, Math.max(0, pending.length - 1)),
        },
        "approval",
        `approval ${event.approval_id} ${event.decision} by ${event.decided_by}`,
      );
    }
    case "turn.completed":
      return {
        ...state,
        running: false,
        usage: formatUsage(event.usage),
        total_usage: mergeUsage(state.total_usage, event.usage),
      };
    case "turn.failed":
      return withEntry({ ...state, running: false }, "error", `turn failed: ${event.error.message}`);
    case "compaction.started":
      return withEntry(state, "info", `compaction started (${event.strategy})`);
    case "compaction.completed":
      return withEntry(state, "info", `compaction freed ~${event.freed_tokens} tokens`);
    default:
      return state;
  }
}

/** Fold one engine approval record into the state (idempotent by id). */
export function applyApprovalRecord(state: ChatState, record: ApprovalRecord): ChatState;
export function applyApprovalRecord(state: ChatState, item: ChatApprovalItem): ChatState;
export function applyApprovalRecord(
  state: ChatState,
  value: ApprovalRecord | ChatApprovalItem,
): ChatState {
  const item: ChatApprovalItem = {
    id: value.id,
    summary: value.summary,
    risk: value.risk,
    expires_at: value.expires_at,
  };
  if (state.pending.some((a) => a.id === item.id)) return state;
  return { ...state, pending: [...state.pending, item], notice: null };
}

export type ChatSubmitResult =
  | { action: "none"; state: ChatState }
  | { action: "exit"; state: ChatState }
  | { action: "send"; state: ChatState; text: string };

/**
 * Interpret one submitted input line: "/exit" (and "/quit") request exit,
 * "/help" and "/usage" print local info entries, anything else is a message
 * for the model. Empty input is a no-op.
 */
export function submitChatInput(state: ChatState, rawLine: string): ChatSubmitResult {
  const line = rawLine.trim();
  if (state.exit_requested) return { action: "none", state };
  if (line === "") return { action: "none", state };
  const cleared = { ...state, input: "", notice: null };
  if (line === "/exit" || line === "/quit") {
    return { action: "exit", state: { ...cleared, exit_requested: true } };
  }
  if (line === "/help") {
    return {
      action: "none",
      state: withEntry(
        cleared,
        "info",
        "commands: /exit quit · /usage show token totals · anything else is sent to the model; y/n resolve the selected approval",
      ),
    };
  }
  if (line === "/usage") {
    return {
      action: "none",
      state: withEntry(cleared, "info", `tokens this session: ${formatUsage(state.total_usage)}`),
    };
  }
  return { action: "send", state: withEntry(cleared, "user", line), text: line };
}

export interface ApprovalKeyResult {
  state: ChatState;
  resolve?: { id: string; decision: "allow" | "deny" };
}

/**
 * Handle one approval-modal keypress against the selected pending approval.
 * Returns the state plus the resolution to perform (the driver executes it).
 */
export function handleApprovalKey(state: ChatState, key: "y" | "n"): ApprovalKeyResult {
  const item = state.pending[state.selected];
  if (item === undefined) return { state };
  const decision: "allow" | "deny" = key === "y" ? "allow" : "deny";
  return {
    state: { ...state, notice: `resolving ${item.id} → ${decision}…` },
    resolve: { id: item.id, decision },
  };
}

/** Move the approval-modal selection (clamped, wraps at the edges). */
export function moveApprovalSelection(state: ChatState, delta: 1 | -1): ChatState {
  if (state.pending.length === 0) return state;
  const n = state.pending.length;
  const next = (state.selected + delta + n) % n;
  return { ...state, selected: next };
}
