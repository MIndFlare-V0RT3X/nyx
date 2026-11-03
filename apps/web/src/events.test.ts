// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  foldApprovals,
  foldEvent,
  initialViewState,
  stateFromProjection,
} from "./events.js";
import type { Projection, SessionEvent, StoredEvent } from "./types.js";

function withSeq<T extends SessionEvent>(seq: number, event: T): StoredEvent {
  return { ...event, seq };
}

function foldAll(events: StoredEvent[]) {
  return events.reduce(foldEvent, initialViewState());
}

describe("foldEvent: ordered turn script", () => {
  const script: StoredEvent[] = [
    withSeq(1, {
      type: "session.created",
      session_id: "s1",
      owner_id: "owner",
      persona_id: "default",
      parent_id: null,
      engagement: null,
      ts: 1,
    }),
    withSeq(2, { type: "turn.started", session_id: "s1", turn_id: "t1", ts: 2 }),
    withSeq(3, {
      type: "message.user",
      session_id: "s1",
      turn_id: "t1",
      content: [{ type: "text", text: "read the file" }],
      ts: 3,
    }),
    withSeq(4, { type: "text.delta", session_id: "s1", turn_id: "t1", text: "Let me ", ts: 4 }),
    withSeq(5, { type: "text.delta", session_id: "s1", turn_id: "t1", text: "check.", ts: 5 }),
    withSeq(6, {
      type: "message.assistant",
      session_id: "s1",
      turn_id: "t1",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "a.txt" } },
      ],
      ts: 6,
    }),
    withSeq(7, {
      type: "tool.call",
      session_id: "s1",
      turn_id: "t1",
      call_id: "c1",
      name: "fs.read",
      input: { path: "a.txt" },
      ts: 7,
    }),
    withSeq(8, {
      type: "tool.result",
      session_id: "s1",
      turn_id: "t1",
      call_id: "c1",
      output: { kind: "text", text: "file contents" },
      ts: 8,
    }),
    withSeq(9, {
      type: "message.assistant",
      session_id: "s1",
      turn_id: "t1",
      content: [{ type: "text", text: "Done." }],
      ts: 9,
    }),
    withSeq(10, {
      type: "turn.completed",
      session_id: "s1",
      turn_id: "t1",
      usage: { input_tokens: 120, output_tokens: 45 },
      ts: 10,
    }),
  ];

  it("folds the full script into the expected view state", () => {
    const state = foldAll(script);

    expect(state.sessionId).toBe("s1");
    expect(state.lastSeq).toBe(10);
    expect(state.turnActive).toBe(false);
    expect(state.usage).toEqual({ input_tokens: 120, output_tokens: 45 });

    // No streaming bubble remains: finalized into the first assistant message.
    expect(state.items.map((item) => item.kind)).toEqual([
      "message", // user
      "message", // assistant (finalized streaming bubble)
      "tool", // fs.read card
      "message", // final assistant
    ]);
    const assistant = state.items[1]!;
    if (assistant.kind !== "message") throw new Error("expected message item");
    expect(assistant.role).toBe("assistant");

    // The tool card is filled.
    const card = state.toolCards["c1"]!;
    expect(card).toMatchObject({
      callId: "c1",
      name: "fs.read",
      status: "ok",
      output: { kind: "text", text: "file contents" },
    });
  });

  it("accumulates text deltas into a streaming bubble before the final message", () => {
    const state = foldAll(script.slice(0, 5));
    const streaming = state.items.at(-1);
    if (streaming === undefined || streaming.kind !== "streaming") throw new Error("expected streaming");
    expect(streaming.text).toBe("Let me check.");
  });

  it("is idempotent per seq (replayed events are skipped)", () => {
    const once = foldAll(script);
    const replayed = script.concat(script.slice(3, 8)).reduce(foldEvent, once);
    expect(replayed).toEqual(once);
    expect(replayed.items).toHaveLength(4);
  });
});

describe("foldEvent: approvals, denials and tool errors", () => {
  const base = [
    withSeq(1, {
      type: "tool.call",
      session_id: "s1",
      turn_id: "t1",
      call_id: "c1",
      name: "web.fetch",
      input: { url: "https://example.com/" },
      ts: 1,
    }),
  ];

  it("approval.requested opens a pending approval; approval.resolved closes it", () => {
    const state = foldAll([
      ...base,
      withSeq(2, {
        type: "approval.requested",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a1",
        action_digest: "deadbeef",
        summary: '"web.fetch" on url="https://example.com/" [risk R2]',
        risk: "R2",
        ts: 1000,
      }),
    ]);
    expect(state.pendingApprovals).toEqual(["a1"]);
    expect(state.approvals["a1"]).toMatchObject({
      id: "a1",
      risk: "R2",
      decision: "pending",
      expiresAt: 1000 + APPROVAL_TTL_MS,
    });
    expect(state.items.at(-1)?.kind).toBe("approval");

    const resolved = foldEvent(state, withSeq(3, {
      type: "approval.resolved",
      session_id: "s1",
      turn_id: "t1",
      approval_id: "a1",
      decision: "allow",
      decided_by: "owner",
      ts: 2000,
    }));
    expect(resolved.pendingApprovals).toEqual([]);
    expect(resolved.approvals["a1"]).toMatchObject({ decision: "allow", decidedBy: "owner" });
  });

  it("action.denied marks the card denied with its reason", () => {
    const state = foldAll([
      ...base,
      withSeq(2, {
        type: "action.denied",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        reason: "scope",
        detail: "host evil.example.net not in engagement scope",
        ts: 2,
      }),
    ]);
    expect(state.toolCards["c1"]).toMatchObject({
      status: "denied",
      denial: { reason: "scope", detail: "host evil.example.net not in engagement scope" },
    });
  });

  it("action.denied without a card renders a standalone denial line", () => {
    const state = foldAll([
      withSeq(1, {
        type: "action.denied",
        session_id: "s1",
        turn_id: "t1",
        call_id: "ghost",
        reason: "policy",
        detail: "denied by rule net-deny",
        rule_id: "net-deny",
        ts: 1,
      }),
    ]);
    const item = state.items.at(-1);
    if (item === undefined || item.kind !== "denial") throw new Error("expected denial item");
    expect(item.reason).toBe("policy");
    expect(item.detail).toBe("denied by rule net-deny");
  });

  it("tool.error marks the card errored", () => {
    const state = foldAll([
      ...base,
      withSeq(2, {
        type: "tool.error",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        error: { name: "TimeoutError", message: "deadline exceeded", code: "tool_timeout" },
        ts: 2,
      }),
    ]);
    expect(state.toolCards["c1"]).toMatchObject({
      status: "error",
      error: { name: "TimeoutError", code: "tool_timeout" },
    });
  });

  it("turn.failed ends the turn and surfaces the error", () => {
    const state = foldAll([
      withSeq(1, { type: "turn.started", session_id: "s1", turn_id: "t1", ts: 1 }),
      withSeq(2, {
        type: "turn.failed",
        session_id: "s1",
        turn_id: "t1",
        error: { name: "ProviderError", message: "all providers failed" },
        ts: 2,
      }),
    ]);
    expect(state.turnActive).toBe(false);
    expect(state.items.at(-1)?.kind).toBe("turn-error");
  });

  it("reasoning.delta accumulates into the same streaming bubble", () => {
    const state = foldAll([
      withSeq(1, { type: "reasoning.delta", session_id: "s1", turn_id: "t1", text: "think ", ts: 1 }),
      withSeq(2, { type: "text.delta", session_id: "s1", turn_id: "t1", text: "answer", ts: 2 }),
      withSeq(3, { type: "reasoning.delta", session_id: "s1", turn_id: "t1", text: "more", ts: 3 }),
    ]);
    const streaming = state.items.at(-1);
    if (streaming === undefined || streaming.kind !== "streaming") throw new Error("expected streaming");
    expect(streaming.reasoning).toBe("think more");
    expect(streaming.text).toBe("answer");
  });
});

describe("stateFromProjection", () => {
  it("anchors tool cards to their tool_use blocks and adopts usage and last_seq", () => {
    const projection: Projection = {
      session_id: "s1",
      last_seq: 9,
      usage: { input_tokens: 10, output_tokens: 5 },
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "calling" },
            { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "x" } },
          ],
        },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      tool_calls: [
        {
          call_id: "c1",
          turn_id: "t1",
          name: "fs.read",
          input: { path: "x" },
          output: { kind: "text", text: "contents" },
          status: "ok",
          ts: 5,
        },
      ],
      approvals: [],
    };

    const state = stateFromProjection("s1", projection);
    expect(state.lastSeq).toBe(9);
    expect(state.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
    expect(state.items.map((item) => item.kind)).toEqual(["message", "message", "tool", "message"]);
    expect(state.toolCards["c1"]).toMatchObject({ name: "fs.read", status: "ok" });

    // The fold continues strictly after the projection's last_seq.
    const continued = foldEvent(
      state,
      withSeq(10, { type: "text.delta", session_id: "s1", turn_id: "t2", text: "live", ts: 10 }),
    );
    const streaming = continued.items.at(-1);
    if (streaming === undefined || streaming.kind !== "streaming") throw new Error("expected streaming");
    expect(streaming.text).toBe("live");
  });

  it("carries pending approvals from the projection", () => {
    const projection: Projection = {
      session_id: "s1",
      last_seq: 2,
      usage: { input_tokens: 0, output_tokens: 0 },
      messages: [],
      tool_calls: [],
      approvals: [
        {
          id: "a1",
          session_id: "s1",
          turn_id: "t1",
          action_digest: "d",
          summary: "s",
          risk: "R3",
          decision: "pending",
          decided_by: null,
          created_at: 1,
          expires_at: 2,
          used_at: null,
        },
      ],
    };
    const state = stateFromProjection("s1", projection);
    expect(state.pendingApprovals).toEqual(["a1"]);
    expect(state.approvals["a1"]?.risk).toBe("R3");
  });
});

describe("foldApprovals", () => {
  it("adds unknown pending records and never downgrades a resolved one", () => {
    const record = {
      id: "a1",
      session_id: "s1",
      turn_id: "t1",
      action_digest: "d",
      summary: "s",
      risk: "R1" as const,
      decision: "pending" as const,
      decided_by: null,
      created_at: 1,
      expires_at: 601_000,
      used_at: null,
    };
    const withEvent = foldAll([
      withSeq(1, {
        type: "approval.requested",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a1",
        action_digest: "d",
        summary: "s",
        risk: "R1",
        ts: 1,
      }),
      withSeq(2, {
        type: "approval.resolved",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a1",
        decision: "deny",
        decided_by: "owner",
        ts: 2,
      }),
      withSeq(3, {
        type: "approval.requested",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a2",
        action_digest: "d2",
        summary: "s2",
        risk: "R2",
        ts: 3,
      }),
    ]);
    const merged = foldApprovals(withEvent, [record]);
    expect(merged.approvals["a1"]?.decision).toBe("deny");
    expect(merged.pendingApprovals).toEqual(["a2"]);
  });
});
