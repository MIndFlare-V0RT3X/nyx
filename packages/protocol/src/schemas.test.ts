// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  ContentBlockSchema,
  EngagementSchema,
  MessageSchema,
  SessionEventSchema,
  StoredEventSchema,
  SubagentInfoSchema,
  SubagentResultSchema,
  SubagentSpecSchema,
  ToolOutputSchema,
} from "./schemas.js";

const engagement = {
  id: "ENG-1",
  operator_id: "owner",
  authorized_at: 1700000000000,
  expires_at: 1900000000000,
  targets: { cidrs: ["10.0.0.0/8"], domains: ["example.com"] },
};

describe("SessionEventSchema", () => {
  it("parses every event variant from fixtures", () => {
    const fixtures = [
      {
        type: "session.created",
        session_id: "s1",
        owner_id: "owner",
        persona_id: "default",
        parent_id: null,
        engagement,
        ts: 1,
      },
      {
        type: "session.created",
        session_id: "s1",
        owner_id: "owner",
        persona_id: "default",
        parent_id: "s0",
        engagement: null,
        ts: 1,
      },
      { type: "turn.started", session_id: "s1", turn_id: "t1", ts: 1 },
      {
        type: "message.user",
        session_id: "s1",
        turn_id: "t1",
        content: [{ type: "text", text: "hi" }],
        ts: 1,
      },
      {
        type: "message.assistant",
        session_id: "s1",
        turn_id: "t1",
        content: [{ type: "text", text: "yo" }],
        ts: 1,
      },
      { type: "text.delta", session_id: "s1", turn_id: "t1", text: "y", ts: 1 },
      { type: "reasoning.delta", session_id: "s1", turn_id: "t1", text: "hm", ts: 1 },
      {
        type: "tool.call",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        name: "fs.read",
        input: { path: "a" },
        ts: 1,
      },
      {
        type: "tool.result",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        output: { kind: "text", text: "ok" },
        ts: 1,
      },
      {
        type: "tool.error",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        error: { name: "E", message: "m" },
        ts: 1,
      },
      {
        type: "action.denied",
        session_id: "s1",
        turn_id: "t1",
        call_id: "c1",
        reason: "scope",
        detail: "host out of scope",
        ts: 1,
      },
      {
        type: "approval.requested",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a1",
        action_digest: "d",
        summary: "s",
        risk: "R2",
        ts: 1,
      },
      {
        type: "approval.resolved",
        session_id: "s1",
        turn_id: "t1",
        approval_id: "a1",
        decision: "allow",
        decided_by: "owner",
        ts: 1,
      },
      {
        type: "compaction.started",
        session_id: "s1",
        turn_id: "t1",
        strategy: "rule-elision",
        ts: 1,
      },
      {
        type: "compaction.completed",
        session_id: "s1",
        turn_id: "t1",
        strategy: "rule-elision",
        freed_tokens: 10,
        ts: 1,
      },
      {
        type: "turn.completed",
        session_id: "s1",
        turn_id: "t1",
        usage: { input_tokens: 1, output_tokens: 2 },
        ts: 1,
      },
      {
        type: "turn.failed",
        session_id: "s1",
        turn_id: "t1",
        error: { name: "E", message: "m" },
        ts: 1,
      },
      { type: "session.forked", session_id: "s1", new_session_id: "s2", at_seq: 5, ts: 1 },
    ];
    expect(fixtures).toHaveLength(18);
    for (const f of fixtures) {
      expect(() => SessionEventSchema.parse(f), `fixture ${f.type}`).not.toThrow();
    }
  });

  it("rejects unknown event types", () => {
    expect(() => SessionEventSchema.parse({ type: "nope.not.an.event", ts: 1 })).toThrow();
  });

  it("rejects a malformed payload under a known type", () => {
    expect(() =>
      SessionEventSchema.parse({
        type: "text.delta",
        session_id: "s",
        turn_id: "t",
        text: 42,
        ts: 1,
      }),
    ).toThrow();
  });

  it("rejects session.created without engagement (null must be explicit)", () => {
    expect(() =>
      SessionEventSchema.parse({
        type: "session.created",
        session_id: "s",
        owner_id: "o",
        persona_id: "p",
        parent_id: null,
        ts: 1,
      }),
    ).toThrow();
  });
});

describe("StoredEventSchema", () => {
  it("requires a non-negative integer seq", () => {
    const base = { type: "turn.started", session_id: "s", turn_id: "t", ts: 1 };
    expect(StoredEventSchema.safeParse({ ...base, seq: 3 }).success).toBe(true);
    expect(StoredEventSchema.safeParse({ ...base, seq: -1 }).success).toBe(false);
    expect(StoredEventSchema.safeParse(base).success).toBe(false);
  });
});

describe("ContentBlockSchema / MessageSchema / ToolOutputSchema", () => {
  it("round-trips a tool_use + tool_result message", () => {
    const m = MessageSchema.parse({
      role: "assistant",
      content: [
        { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "x" } },
        { type: "tool_result", call_id: "c1", output: { kind: "json", json: { n: 1 } } },
      ],
    });
    expect(m.role).toBe("assistant");
  });

  it("rejects an unknown block type", () => {
    expect(ContentBlockSchema.safeParse({ type: "video", url: "x" }).success).toBe(false);
  });

  it("rejects a file output without bytes", () => {
    expect(
      ToolOutputSchema.safeParse({ kind: "file", path: "x", mime: "text/plain" }).success,
    ).toBe(false);
  });
});

describe("EngagementSchema", () => {
  it("parses a full engagement", () => {
    const e = EngagementSchema.parse(engagement);
    expect(e.targets.cidrs).toEqual(["10.0.0.0/8"]);
  });

  it("requires targets", () => {
    const { targets: _targets, ...without } = engagement;
    expect(EngagementSchema.safeParse(without).success).toBe(false);
  });

  it("rejects an empty engagement id", () => {
    expect(EngagementSchema.safeParse({ ...engagement, id: "" }).success).toBe(false);
  });
});

describe("Subagent boundary schemas (Phase 3)", () => {
  it("parses the four subagent lifecycle events", () => {
    expect(
      SessionEventSchema.safeParse({
        type: "subagent.spawned",
        session_id: "child-1",
        subagent_session_id: "child-1",
        turn_id: "sub-t1",
        parent_session_id: "parent-1",
        parent_turn_id: "t1",
        task: "review the thing",
        depth: 1,
        ts: 1,
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        type: "subagent.completed",
        session_id: "parent-1",
        subagent_session_id: "child-1",
        parent_session_id: "parent-1",
        summary: "done",
        tokens_used: 10,
        duration_ms: 5,
        ts: 2,
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        type: "subagent.failed",
        session_id: "child-1",
        subagent_session_id: "child-1",
        parent_session_id: "parent-1",
        error: { name: "E", message: "m" },
        ts: 3,
      }).success,
    ).toBe(true);
    expect(
      SessionEventSchema.safeParse({
        type: "subagent.aborted",
        session_id: "parent-1",
        subagent_session_id: "child-1",
        parent_session_id: "parent-1",
        reason: "parent turn aborted",
        ts: 4,
      }).success,
    ).toBe(true);
  });

  it("rejects a subagent.spawned event without the child id", () => {
    expect(
      SessionEventSchema.safeParse({
        type: "subagent.spawned",
        session_id: "parent-1",
        turn_id: "t1",
        parent_session_id: "parent-1",
        parent_turn_id: "t1",
        task: "x",
        depth: 1,
        ts: 1,
      }).success,
    ).toBe(false);
  });

  it("round-trips a SubagentSpec, result, and info", () => {
    const spec = SubagentSpecSchema.parse({
      task: "research X",
      tools: ["fs.read"],
      budget_tokens: 2048,
    });
    expect(spec.task).toBe("research X");
    expect(SubagentSpecSchema.safeParse({ task: "" }).success).toBe(false);
    expect(SubagentSpecSchema.safeParse({ task: "x", bogus: 1 }).success).toBe(false);
    expect(SubagentSpecSchema.safeParse({ task: "x", budget_tokens: 10 }).success).toBe(false);

    const result = SubagentResultSchema.parse({
      session_id: "child-1",
      summary: "found 3 issues",
      state: "completed",
      tokens_used: 512,
      duration_ms: 12,
    });
    expect(result.state).toBe("completed");
    expect(
      SubagentResultSchema.safeParse({ session_id: "c", summary: "", state: "weird" }).success,
    ).toBe(false);

    const info = SubagentInfoSchema.parse({
      session_id: "child-1",
      parent_session_id: "parent-1",
      parent_turn_id: "t1",
      spawned_at: 1,
      state: "running",
      task: "review",
    });
    expect(info.state).toBe("running");
  });
});
