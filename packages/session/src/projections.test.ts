// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "@nyx/protocol";
import { APPROVAL_TTL_MS } from "./projections.js";
import { SessionStoreImpl } from "./store.js";

let ts = 1_000_000;
const nextTs = (): number => (ts += 1);

function msg(sid: string, turn: string, role: "user" | "assistant", text: string): SessionEvent {
  return {
    type: role === "user" ? "message.user" : "message.assistant",
    session_id: sid,
    turn_id: turn,
    content: [
      { type: "text", text },
      { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "x" } },
    ],
    ts: nextTs(),
  };
}

function call(sid: string, turn: string, callId: string, name = "fs.read"): SessionEvent {
  return {
    type: "tool.call",
    session_id: sid,
    turn_id: turn,
    call_id: callId,
    name,
    input: { path: "/tmp/x", opts: { encoding: "utf8" } },
    ts: nextTs(),
  };
}

function result(sid: string, turn: string, callId: string): SessionEvent {
  return {
    type: "tool.result",
    session_id: sid,
    turn_id: turn,
    call_id: callId,
    output: { kind: "json", json: { lines: 42 } },
    ts: nextTs(),
  };
}

function error(sid: string, turn: string, callId: string): SessionEvent {
  return {
    type: "tool.error",
    session_id: sid,
    turn_id: turn,
    call_id: callId,
    error: { name: "ToolError", message: "disk on fire", retryable: false },
    ts: nextTs(),
  };
}

function denied(sid: string, turn: string, callId: string): SessionEvent {
  return {
    type: "action.denied",
    session_id: sid,
    turn_id: turn,
    call_id: callId,
    reason: "policy",
    detail: "R3 tool requires approval",
    rule_id: "ask-r3",
    ts: nextTs(),
  };
}

describe("projections", () => {
  it("projects message.user/assistant into messages and skips deltas", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sid = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(sid, [
      { type: "turn.started", session_id: sid, turn_id: "t1", ts: nextTs() },
      msg(sid, "t1", "user", "hi"),
      { type: "text.delta", session_id: sid, turn_id: "t1", text: "partial", ts: nextTs() },
      { type: "reasoning.delta", session_id: sid, turn_id: "t1", text: "thinking", ts: nextTs() },
      msg(sid, "t1", "assistant", "hello"),
    ]);
    const p = await store.projection(sid);
    expect(p.messages).toHaveLength(2);
    expect(p.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", call_id: "c1", name: "fs.read", input: { path: "x" } },
      ],
    });
    expect(p.messages[1]?.role).toBe("assistant");
    // session.created + 5 events
    expect(p.last_seq).toBe(6);
    store.close();
  });

  it("tool.call alone leaves the row pending", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sid = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(sid, [call(sid, "t1", "c1")]);
    const p = await store.projection(sid);
    expect(p.tool_calls).toHaveLength(1);
    expect(p.tool_calls[0]).toEqual({
      call_id: "c1",
      turn_id: "t1",
      name: "fs.read",
      input: { path: "/tmp/x", opts: { encoding: "utf8" } },
      output: null,
      status: "pending",
      ts: expect.any(Number),
    });
    store.close();
  });

  it("tool.result marks ok and stores the parsed output", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sid = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(sid, [call(sid, "t1", "c1"), result(sid, "t1", "c1")]);
    const p = await store.projection(sid);
    expect(p.tool_calls[0]?.status).toBe("ok");
    expect(p.tool_calls[0]?.output).toEqual({ kind: "json", json: { lines: 42 } });
    store.close();
  });

  it("tool.error marks error; action.denied marks denied (output stays null)", async () => {
    const store = new SessionStoreImpl(":memory:");
    const s1 = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    const s2 = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(s1, [call(s1, "t1", "c1"), error(s1, "t1", "c1")]);
    await store.append(s2, [call(s2, "t1", "c1"), denied(s2, "t1", "c1")]);
    const p1 = await store.projection(s1);
    expect(p1.tool_calls[0]?.status).toBe("error");
    expect(p1.tool_calls[0]?.output).toBeNull();
    const p2 = await store.projection(s2);
    expect(p2.tool_calls[0]?.status).toBe("denied");
    expect(p2.tool_calls[0]?.output).toBeNull();
    // the same call_id in two sessions is two independent rows
    expect(p1.tool_calls[0]?.call_id).toBe("c1");
    expect(p2.tool_calls[0]?.call_id).toBe("c1");
    store.close();
  });

  it("projects the approval lifecycle with the 10-minute TTL", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sid = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    const requested: SessionEvent = {
      type: "approval.requested",
      session_id: sid,
      turn_id: "t1",
      approval_id: "appr-1",
      action_digest: "sha256:abc",
      summary: "rm -rf /tmp/cache",
      risk: "R3",
      ts: 5_000,
    };
    await store.append(sid, [requested]);
    let p = await store.projection(sid);
    expect(p.approvals).toHaveLength(1);
    expect(p.approvals[0]).toEqual({
      id: "appr-1",
      session_id: sid,
      turn_id: "t1",
      action_digest: "sha256:abc",
      summary: "rm -rf /tmp/cache",
      risk: "R3",
      decision: "pending",
      decided_by: null,
      created_at: 5_000,
      expires_at: 5_000 + APPROVAL_TTL_MS,
      used_at: null,
    });

    await store.append(sid, [
      {
        type: "approval.resolved",
        session_id: sid,
        turn_id: "t1",
        approval_id: "appr-1",
        decision: "deny",
        decided_by: "owner",
        ts: 6_000,
      },
    ]);
    p = await store.projection(sid);
    expect(p.approvals[0]?.decision).toBe("deny");
    expect(p.approvals[0]?.decided_by).toBe("owner");
    // resolution does not rewrite creation bookkeeping
    expect(p.approvals[0]?.created_at).toBe(5_000);
    expect(p.approvals[0]?.expires_at).toBe(5_000 + APPROVAL_TTL_MS);
    store.close();
  });

  it("sums usage across turn.completed events via mergeUsage", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sid = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(sid, [
      {
        type: "turn.completed",
        session_id: sid,
        turn_id: "t1",
        usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10 },
        ts: nextTs(),
      },
      {
        type: "turn.completed",
        session_id: sid,
        turn_id: "t2",
        usage: { input_tokens: 30, output_tokens: 20, cache_read_tokens: 5, total_tokens: 999 },
        ts: nextTs(),
      },
      {
        type: "turn.failed",
        session_id: sid,
        turn_id: "t3",
        error: { name: "E", message: "m" },
        ts: nextTs(),
      },
    ]);
    const p = await store.projection(sid);
    // mergeUsage recomputes total_tokens; the caller-supplied 999 is ignored
    expect(p.usage).toEqual({
      input_tokens: 130,
      output_tokens: 70,
      reasoning_tokens: 10,
      cache_read_tokens: 5,
      total_tokens: 210,
    });
    store.close();
  });

  it("throws not_found for unknown sessions", async () => {
    const store = new SessionStoreImpl(":memory:");
    await expect(store.projection("nope")).rejects.toMatchObject({ code: "not_found" });
    store.close();
  });

  it("keeps projections of different sessions isolated", async () => {
    const store = new SessionStoreImpl(":memory:");
    const s1 = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    const s2 = (await store.create({ owner_id: "o", persona_id: "p" })).session_id;
    await store.append(s1, [msg(s1, "t1", "user", "a")]);
    await store.append(s2, [msg(s2, "t1", "user", "b"), msg(s2, "t1", "assistant", "c")]);
    expect((await store.projection(s1)).messages).toHaveLength(1);
    expect((await store.projection(s2)).messages).toHaveLength(2);
    store.close();
  });
});
