// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Engagement, SessionEvent, StoredEvent } from "@nyx/protocol";
import { SessionStoreImpl } from "./store.js";

let ts = 1_000_000;
const nextTs = (): number => (ts += 1);

function userMsg(sid: string, turn: string, text: string): SessionEvent {
  return {
    type: "message.user",
    session_id: sid,
    turn_id: turn,
    content: [{ type: "text", text }],
    ts: nextTs(),
  };
}

function assistantMsg(sid: string, turn: string, text: string): SessionEvent {
  return {
    type: "message.assistant",
    session_id: sid,
    turn_id: turn,
    content: [{ type: "text", text }],
    ts: nextTs(),
  };
}

function toolCall(sid: string, turn: string, i: number): SessionEvent {
  return {
    type: "tool.call",
    session_id: sid,
    turn_id: turn,
    call_id: `call-${i}`,
    name: "fs.read",
    input: { path: `/tmp/f-${i}.txt` },
    ts: nextTs(),
  };
}

function toolResult(sid: string, turn: string, i: number): SessionEvent {
  return {
    type: "tool.result",
    session_id: sid,
    turn_id: turn,
    call_id: `call-${i}`,
    output: { kind: "text", text: `content-${i}` },
    ts: nextTs(),
  };
}

function approvalPair(sid: string, turn: string, i: number): SessionEvent[] {
  return [
    {
      type: "approval.requested",
      session_id: sid,
      turn_id: turn,
      approval_id: `appr-${i}`,
      action_digest: `digest-${i}`,
      summary: `read /tmp/f-${i}.txt`,
      risk: "R2",
      ts: nextTs(),
    },
    {
      type: "approval.resolved",
      session_id: sid,
      turn_id: turn,
      approval_id: `appr-${i}`,
      decision: "allow",
      decided_by: "owner",
      ts: nextTs(),
    },
  ];
}

/** Builds a realistic mixed-history event stream of roughly `count` events. */
function history(sid: string, count: number): SessionEvent[] {
  const out: SessionEvent[] = [];
  let i = 0;
  while (out.length < count) {
    const turn = `turn-${i}`;
    out.push({ type: "turn.started", session_id: sid, turn_id: turn, ts: nextTs() });
    out.push(userMsg(sid, turn, `question ${i}`));
    out.push({ type: "text.delta", session_id: sid, turn_id: turn, text: `t${i}`, ts: nextTs() });
    out.push(toolCall(sid, turn, i));
    out.push(toolResult(sid, turn, i));
    if (i % 5 === 0) out.push(...approvalPair(sid, turn, i));
    out.push(assistantMsg(sid, turn, `answer ${i}`));
    out.push({
      type: "turn.completed",
      session_id: sid,
      turn_id: turn,
      usage: { input_tokens: 10 + i, output_tokens: 5 + i },
      ts: nextTs(),
    });
    i += 1;
  }
  return out.slice(0, count);
}

const engagement: Engagement = {
  id: "ENG-1",
  operator_id: "owner-1",
  authorized_at: 1,
  expires_at: 2,
  targets: { cidrs: [], domains: [] },
};

/** Compares event payloads ignoring session_id and seq (fork rewrites both). */
function comparable(ev: StoredEvent): Record<string, unknown> {
  const { session_id: _sid, seq: _seq, ...rest } = ev;
  void _sid;
  void _seq;
  return rest as Record<string, unknown>;
}

describe("fork", () => {
  it("copies the event prefix, records session.forked on the parent, and links metadata", async () => {
    const store = new SessionStoreImpl(":memory:");
    const parent = await store.create({
      owner_id: "owner-1",
      persona_id: "persona-a",
      title: "research",
      engagement,
    });
    // parent log: seq 1 = session.created, then >= 60 more events
    await store.append(parent.session_id, history(parent.session_id, 64));
    const parentEvents = await store.read(parent.session_id);
    expect(parentEvents.length).toBeGreaterThanOrEqual(60);

    const child = await store.fork(parent.session_id, 50);

    // child metadata
    expect(child.parent_id).toBe(parent.session_id);
    expect(child.title).toBe("research (fork)");
    expect(child.owner_id).toBe(parent.owner_id);
    expect(child.persona_id).toBe(parent.persona_id);
    expect(child.engagement).toEqual(engagement);

    // child's first 50 events carry payloads identical to the parent's first
    // 50 (session_id and seq excluded — those are rewritten per session)
    const childEvents = await store.read(child.session_id);
    expect(childEvents).toHaveLength(50);
    for (let i = 0; i < 50; i += 1) {
      expect(comparable(childEvents[i]!)).toEqual(comparable(parentEvents[i]!));
    }
    // the child's log starts from its own session.created
    expect(childEvents[0]?.type).toBe("session.created");
    expect((childEvents[0] as { session_id: string }).session_id).toBe(child.session_id);
    // fresh seqs were assigned in the child
    for (let i = 1; i < childEvents.length; i += 1) {
      expect(childEvents[i]!.seq).toBe(childEvents[i - 1]!.seq + 1);
    }

    // the parent got a session.forked event appended at the end
    const afterFork = await store.read(parent.session_id);
    expect(afterFork).toHaveLength(parentEvents.length + 1);
    const forkedEvent = afterFork[afterFork.length - 1];
    expect(forkedEvent?.type).toBe("session.forked");
    expect(forkedEvent).toMatchObject({
      session_id: parent.session_id,
      new_session_id: child.session_id,
      at_seq: 50,
    });

    // child projections were built from the copied prefix
    const childProjection = await store.projection(child.session_id);
    expect(childProjection.last_seq).toBe(childEvents[childEvents.length - 1]!.seq);
    expect(childProjection.messages.length).toBeGreaterThan(0);
    expect(childProjection.tool_calls.length).toBeGreaterThan(0);
    expect(childProjection.usage.total_tokens).toBeGreaterThan(0);

    // parent and child are independent from here on
    await store.append(child.session_id, [userMsg(child.session_id, "post-fork", "only in child")]);
    expect(await store.read(parent.session_id)).toHaveLength(afterFork.length);
    store.close();
  });

  it("rejects invalid at_seq with a typed error", async () => {
    const store = new SessionStoreImpl(":memory:");
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    await expect(store.fork(meta.session_id, 0)).rejects.toMatchObject({
      code: "validation_failed",
    });
    await expect(store.fork("nope", 1)).rejects.toMatchObject({ code: "not_found" });
    store.close();
  });

  it("forking beyond the log copies everything available", async () => {
    const store = new SessionStoreImpl(":memory:");
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    await store.append(meta.session_id, history(meta.session_id, 10));
    const before = (await store.read(meta.session_id)).length;
    const child = await store.fork(meta.session_id, 999);
    expect(await store.read(child.session_id)).toHaveLength(before);
    store.close();
  });
});
