// SPDX-License-Identifier: AGPL-3.0-or-later
// The event reducer: folds StoredEvents into an explicit SessionEventViewState
// used by the session view. Pure module — no React, no I/O. Folding is
// idempotent per seq (replayed events are skipped), so the same state can be
// rebuilt from a projection snapshot plus the SSE tail.

import type {
  ApprovalRecord,
  ContentBlock,
  Projection,
  RiskTier,
  SerializedError,
  StoredEvent,
  ToolCallRecord,
  ToolOutput,
  Usage,
} from "./types.js";

/** Approvals are single-use and expire 10 minutes after creation (protocol). */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface ToolCardView {
  callId: string;
  name: string;
  input: unknown;
  status: "pending" | "ok" | "error" | "denied";
  output?: ToolOutput;
  error?: SerializedError;
  denial?: { reason: "policy" | "approval" | "scope"; detail: string; ruleId?: string };
  ts: number;
}

export interface ApprovalView {
  id: string;
  turnId: string | null;
  summary: string;
  risk: RiskTier;
  actionDigest: string;
  createdAt: number;
  expiresAt: number;
  decision: "pending" | "allow" | "deny";
  decidedBy: string | null;
}

export type TimelineItem =
  | { kind: "message"; id: string; role: "user" | "assistant"; content: ContentBlock[]; ts: number }
  | { kind: "streaming"; id: string; text: string; reasoning: string; ts: number }
  | { kind: "tool"; id: string; callId: string; ts: number }
  | { kind: "approval"; id: string; approvalId: string; ts: number }
  | { kind: "denial"; id: string; callId: string; reason: string; detail: string; ts: number }
  | { kind: "turn-error"; id: string; error: SerializedError; ts: number };

export interface SessionEventViewState {
  sessionId: string | null;
  /** Highest seq folded so far; also the SSE resume cursor. */
  lastSeq: number;
  items: TimelineItem[];
  toolCards: Record<string, ToolCardView>;
  approvals: Record<string, ApprovalView>;
  /** Ordered ids of approvals still awaiting a decision. */
  pendingApprovals: string[];
  usage: Usage | null;
  turnActive: boolean;
}

export function initialViewState(): SessionEventViewState {
  return {
    sessionId: null,
    lastSeq: 0,
    items: [],
    toolCards: {},
    approvals: {},
    pendingApprovals: [],
    usage: null,
    turnActive: false,
  };
}

function approvalViewFromRecord(record: ApprovalRecord): ApprovalView {
  return {
    id: record.id,
    turnId: record.turn_id,
    summary: record.summary,
    risk: record.risk,
    actionDigest: record.action_digest,
    createdAt: record.created_at,
    expiresAt: record.expires_at,
    decision: record.decision,
    decidedBy: record.decided_by,
  };
}

function cardFromRecord(record: ToolCallRecord): ToolCardView {
  return {
    callId: record.call_id,
    name: record.name,
    input: record.input,
    status: record.status,
    ...(record.output !== null && record.output !== undefined
      ? { output: record.output as ToolOutput }
      : {}),
    ts: record.ts,
  };
}

function cardFromBlock(block: Extract<ContentBlock, { type: "tool_use" }>): ToolCardView {
  return { callId: block.call_id, name: block.name, input: block.input, status: "pending", ts: 0 };
}

/**
 * Builds the initial state from the REST projection. Tool cards anchor to the
 * tool_use blocks of the message that requested them (messages carry no
 * timestamps; tool_calls records do), which converges with the live fold:
 * message items render only text/reasoning blocks, cards are separate items.
 * Approval history has no message anchor, so it lands at the end of the
 * timeline (live approvals are placed exactly as they arrive).
 */
export function stateFromProjection(
  sessionId: string,
  projection: Projection,
): SessionEventViewState {
  const state = initialViewState();
  state.sessionId = sessionId;
  state.lastSeq = projection.last_seq;
  state.usage = projection.usage;

  const cards: Record<string, ToolCardView> = {};
  for (const record of projection.tool_calls) cards[record.call_id] = cardFromRecord(record);
  state.toolCards = cards;

  const items: TimelineItem[] = [];
  const anchored = new Set<string>();
  let index = 0;
  for (const message of projection.messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    items.push({
      kind: "message",
      id: `p${index}`,
      role: message.role,
      content: message.content,
      ts: 0,
    });
    index += 1;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const card = cards[block.call_id] ?? cardFromBlock(block);
      cards[block.call_id] = card;
      anchored.add(block.call_id);
      items.push({ kind: "tool", id: `p${index}`, callId: block.call_id, ts: card.ts });
      index += 1;
    }
  }
  // Defensive: cards the messages never referenced still get rendered.
  for (const record of projection.tool_calls) {
    if (anchored.has(record.call_id)) continue;
    items.push({ kind: "tool", id: `p${index}`, callId: record.call_id, ts: record.ts });
    index += 1;
  }
  for (const record of projection.approvals) {
    items.push({ kind: "approval", id: `p${index}`, approvalId: record.id, ts: record.created_at });
    index += 1;
  }
  state.items = items;

  const approvals: Record<string, ApprovalView> = {};
  const pending: string[] = [];
  for (const record of projection.approvals) {
    approvals[record.id] = approvalViewFromRecord(record);
    if (record.decision === "pending") pending.push(record.id);
  }
  state.approvals = approvals;
  state.pendingApprovals = pending;
  return state;
}

/**
 * Folds one stored event into the state. Events with seq <= lastSeq (already
 * seen — a replayed backlog or a duplicate after reconnect) are no-ops.
 */
export function foldEvent(state: SessionEventViewState, event: StoredEvent): SessionEventViewState {
  if (event.seq <= state.lastSeq) return state;
  const next: SessionEventViewState = { ...state, lastSeq: event.seq };

  switch (event.type) {
    case "session.created":
      next.sessionId = event.session_id;
      return next;
    case "turn.started":
      next.turnActive = true;
      return next;
    case "turn.completed":
      next.turnActive = false;
      next.usage = event.usage;
      return next;
    case "turn.failed":
      next.turnActive = false;
      next.items = [
        ...state.items,
        { kind: "turn-error", id: `e${event.seq}`, error: event.error, ts: event.ts },
      ];
      return next;
    case "message.user":
      next.items = [
        ...state.items,
        {
          kind: "message",
          id: `e${event.seq}`,
          role: "user",
          content: event.content,
          ts: event.ts,
        },
      ];
      return next;
    case "message.assistant": {
      const message: TimelineItem = {
        kind: "message",
        id: `e${event.seq}`,
        role: "assistant",
        content: event.content,
        ts: event.ts,
      };
      // The final assistant message replaces the streaming bubble it finalizes.
      const last = state.items[state.items.length - 1];
      next.items =
        last !== undefined && last.kind === "streaming"
          ? [...state.items.slice(0, -1), message]
          : [...state.items, message];
      return next;
    }
    case "text.delta":
    case "reasoning.delta": {
      const last = state.items[state.items.length - 1];
      if (last !== undefined && last.kind === "streaming") {
        const patched: TimelineItem =
          event.type === "text.delta"
            ? { ...last, text: last.text + event.text }
            : { ...last, reasoning: last.reasoning + event.text };
        next.items = [...state.items.slice(0, -1), patched];
      } else {
        next.items = [
          ...state.items,
          {
            kind: "streaming",
            id: `e${event.seq}`,
            text: event.type === "text.delta" ? event.text : "",
            reasoning: event.type === "reasoning.delta" ? event.text : "",
            ts: event.ts,
          },
        ];
      }
      return next;
    }
    case "tool.call":
      next.toolCards = {
        ...state.toolCards,
        [event.call_id]: {
          callId: event.call_id,
          name: event.name,
          input: event.input,
          status: "pending",
          ts: event.ts,
        },
      };
      next.items = [
        ...state.items,
        { kind: "tool", id: `e${event.seq}`, callId: event.call_id, ts: event.ts },
      ];
      return next;
    case "tool.result": {
      const card = state.toolCards[event.call_id];
      if (card !== undefined) {
        next.toolCards = {
          ...state.toolCards,
          [event.call_id]: { ...card, status: "ok", output: event.output },
        };
        return next;
      }
      next.toolCards = {
        ...state.toolCards,
        [event.call_id]: {
          callId: event.call_id,
          name: "unknown",
          input: undefined,
          status: "ok",
          output: event.output,
          ts: event.ts,
        },
      };
      next.items = [
        ...state.items,
        { kind: "tool", id: `e${event.seq}`, callId: event.call_id, ts: event.ts },
      ];
      return next;
    }
    case "tool.error": {
      const card = state.toolCards[event.call_id];
      if (card !== undefined) {
        next.toolCards = {
          ...state.toolCards,
          [event.call_id]: { ...card, status: "error", error: event.error },
        };
        return next;
      }
      next.items = [
        ...state.items,
        { kind: "turn-error", id: `e${event.seq}`, error: event.error, ts: event.ts },
      ];
      return next;
    }
    case "action.denied": {
      const card = state.toolCards[event.call_id];
      if (card !== undefined) {
        next.toolCards = {
          ...state.toolCards,
          [event.call_id]: {
            ...card,
            status: "denied",
            denial: {
              reason: event.reason,
              detail: event.detail,
              ...(event.rule_id !== undefined ? { ruleId: event.rule_id } : {}),
            },
          },
        };
        return next;
      }
      next.items = [
        ...state.items,
        {
          kind: "denial",
          id: `e${event.seq}`,
          callId: event.call_id,
          reason: event.reason,
          detail: event.detail,
          ts: event.ts,
        },
      ];
      return next;
    }
    case "approval.requested": {
      const view: ApprovalView = {
        id: event.approval_id,
        turnId: event.turn_id,
        summary: event.summary,
        risk: event.risk,
        actionDigest: event.action_digest,
        createdAt: event.ts,
        expiresAt: event.ts + APPROVAL_TTL_MS,
        decision: "pending",
        decidedBy: null,
      };
      next.approvals = { ...state.approvals, [event.approval_id]: view };
      next.pendingApprovals = state.pendingApprovals.includes(event.approval_id)
        ? state.pendingApprovals
        : [...state.pendingApprovals, event.approval_id];
      next.items = [
        ...state.items,
        { kind: "approval", id: `e${event.seq}`, approvalId: event.approval_id, ts: event.ts },
      ];
      return next;
    }
    case "approval.resolved": {
      const existing = state.approvals[event.approval_id];
      next.approvals =
        existing === undefined
          ? state.approvals
          : {
              ...state.approvals,
              [event.approval_id]: {
                ...existing,
                decision: event.decision,
                decidedBy: event.decided_by,
              },
            };
      next.pendingApprovals = state.pendingApprovals.filter((id) => id !== event.approval_id);
      return next;
    }
    case "compaction.started":
    case "compaction.completed":
    case "session.forked":
      return next;
  }
}

/**
 * Merges REST-sourced approval records (GET /v1/approvals, which lists only
 * pending ones) into the state. A resolved approval in the state is never
 * downgraded back to pending by an older snapshot.
 */
export function foldApprovals(
  state: SessionEventViewState,
  records: ApprovalRecord[],
): SessionEventViewState {
  if (records.length === 0) return state;
  const approvals = { ...state.approvals };
  let pending = [...state.pendingApprovals];
  for (const record of records) {
    const existing = approvals[record.id];
    if (existing === undefined) {
      approvals[record.id] = approvalViewFromRecord(record);
      if (record.decision === "pending" && !pending.includes(record.id)) pending.push(record.id);
      continue;
    }
    const decision =
      existing.decision === "pending" && record.decision !== "pending"
        ? record.decision
        : existing.decision;
    approvals[record.id] = {
      ...existing,
      createdAt: record.created_at,
      expiresAt: record.expires_at,
      decision,
      ...(decision !== "pending" ? { decidedBy: existing.decidedBy ?? record.decided_by } : {}),
    };
    if (decision !== "pending") pending = pending.filter((id) => id !== record.id);
  }
  return { ...state, approvals, pendingApprovals: pending };
}
