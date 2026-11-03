// SPDX-License-Identifier: AGPL-3.0-or-later
// Replay acceptance: projections rebuilt from the event log must be
// byte-identical to the incrementally maintained ones.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { mergeUsage } from "@nyx/protocol";
import type { SessionEvent, SessionStore, StoredEvent, Usage } from "@nyx/protocol";
import { SessionStoreImpl } from "./store.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Deterministic PRNG so every run generates the same "random" history. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

interface Gen {
  events: SessionEvent[];
  expectedMessages: number;
  expectedToolCalls: number;
  expectedApprovals: number;
  expectedUsage: Usage;
}

/**
 * Generates a realistic mixed history (messages, deltas, tool lifecycle,
 * approvals, usage) of exactly `count` events for one session. Expected
 * projection counts are derived from the exact generated list, so they can
 * never drift from what gets appended.
 */
function genHistory(seed: number, sid: string, count: number): Gen {
  const rand = lcg(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length) % items.length]!;
  const events: SessionEvent[] = [];
  let ts = 1_000_000;
  const tick = (): number => (ts += 1);
  const push = (e: SessionEvent): void => {
    if (events.length < count) events.push(e);
  };
  let turn = 0;
  let callN = 0;
  let apprN = 0;
  while (events.length < count) {
    const turnId = `turn-${turn}`;
    push({ type: "turn.started", session_id: sid, turn_id: turnId, ts: tick() });
    push({
      type: "message.user",
      session_id: sid,
      turn_id: turnId,
      content: [{ type: "text", text: `question ${turn}` }],
      ts: tick(),
    });
    for (let d = 0; d < 1 + Math.floor(rand() * 3); d += 1) {
      push({
        type: "text.delta",
        session_id: sid,
        turn_id: turnId,
        text: `delta-${d}`,
        ts: tick(),
      });
    }
    if (rand() < 0.5) {
      push({ type: "reasoning.delta", session_id: sid, turn_id: turnId, text: "hmm", ts: tick() });
    }
    push({
      type: "message.assistant",
      session_id: sid,
      turn_id: turnId,
      content: [
        { type: "reasoning", text: "plan" },
        { type: "text", text: `answer ${turn}` },
      ],
      ts: tick(),
    });
    const toolCount = rand() < 0.3 ? 2 : 1;
    for (let t = 0; t < toolCount; t += 1) {
      callN += 1;
      const callId = `call-${callN}`;
      push({
        type: "tool.call",
        session_id: sid,
        turn_id: turnId,
        call_id: callId,
        name: pick(["fs.read", "net.fetch", "proc.spawn"]),
        input: { path: `/tmp/f${callN}.txt`, n: callN },
        ts: tick(),
      });
      const outcome = pick(["result", "result", "error", "denied"] as const);
      if (outcome === "result") {
        push({
          type: "tool.result",
          session_id: sid,
          turn_id: turnId,
          call_id: callId,
          output: pick([
            { kind: "text", text: "ok" },
            { kind: "json", json: { n: callN } },
            { kind: "file", path: "/tmp/out", bytes: callN, mime: "text/plain" },
          ]),
          ts: tick(),
        });
      } else if (outcome === "error") {
        push({
          type: "tool.error",
          session_id: sid,
          turn_id: turnId,
          call_id: callId,
          error: { name: "ToolError", message: `boom ${callN}`, retryable: rand() < 0.5 },
          ts: tick(),
        });
      } else {
        push({
          type: "action.denied",
          session_id: sid,
          turn_id: turnId,
          call_id: callId,
          reason: pick(["policy", "approval", "scope"] as const),
          detail: "not allowed",
          ts: tick(),
        });
      }
    }
    if (rand() < 0.2) {
      apprN += 1;
      const approvalId = `appr-${apprN}`;
      push({
        type: "approval.requested",
        session_id: sid,
        turn_id: turnId,
        approval_id: approvalId,
        action_digest: `sha256:${approvalId}`,
        summary: `risky thing ${apprN}`,
        risk: pick(["R1", "R2", "R3", "R4"] as const),
        ts: tick(),
      });
      push({
        type: "approval.resolved",
        session_id: sid,
        turn_id: turnId,
        approval_id: approvalId,
        decision: pick(["allow", "deny"] as const),
        decided_by: "owner",
        ts: tick(),
      });
    }
    if (rand() < 0.1) {
      push({
        type: "compaction.started",
        session_id: sid,
        turn_id: turnId,
        strategy: "rule-elision",
        ts: tick(),
      });
      push({
        type: "compaction.completed",
        session_id: sid,
        turn_id: turnId,
        strategy: "rule-elision",
        freed_tokens: 128,
        ts: tick(),
      });
    }
    if (events.length >= count) break;
    const usage: Usage = {
      input_tokens: 100 + turn,
      output_tokens: 40 + Math.floor(rand() * 10),
    };
    if (rand() < 0.4) usage.reasoning_tokens = Math.floor(rand() * 50);
    if (rand() < 0.4) usage.cache_read_tokens = Math.floor(rand() * 500);
    push({ type: "turn.completed", session_id: sid, turn_id: turnId, usage, ts: tick() });
    if (rand() < 0.05) {
      push({
        type: "turn.failed",
        session_id: sid,
        turn_id: turnId,
        error: { name: "ModelError", message: "nope" },
        ts: tick(),
      });
    }
    turn += 1;
  }
  const usages = events
    .filter(
      (e): e is Extract<SessionEvent, { type: "turn.completed" }> => e.type === "turn.completed",
    )
    .map((e) => e.usage);
  return {
    events,
    expectedMessages: events.filter(
      (e) => e.type === "message.user" || e.type === "message.assistant",
    ).length,
    expectedToolCalls: events.filter((e) => e.type === "tool.call").length,
    expectedApprovals: events.filter((e) => e.type === "approval.requested").length,
    expectedUsage: mergeUsage(...usages),
  };
}

function snapshotRawRows(store: SessionStoreImpl): string {
  const db = store.db;
  return JSON.stringify({
    messages: db.prepare("SELECT * FROM messages ORDER BY session_id, seq").all(),
    tool_calls: db.prepare("SELECT * FROM tool_calls ORDER BY session_id, seq").all(),
    approvals: db.prepare("SELECT * FROM approvals ORDER BY session_id, created_at, id").all(),
    projection_version: db.prepare("SELECT * FROM projection_version ORDER BY name").all(),
  });
}

async function snapshotProjections(store: SessionStore, sids: string[]): Promise<string> {
  const parts: string[] = [];
  for (const sid of sids) {
    const p = await store.projection(sid);
    parts.push(
      JSON.stringify({
        session_id: p.session_id,
        last_seq: p.last_seq,
        messages: p.messages,
        tool_calls: p.tool_calls,
        approvals: p.approvals,
        usage: p.usage,
      }),
    );
  }
  return JSON.stringify(parts);
}

describe("replay determinism", () => {
  it("rebuilds byte-identical projections from ~2000 mixed events across sessions", async () => {
    const store = new SessionStoreImpl(":memory:");
    const sids: string[] = [];
    const gens: Gen[] = [];
    for (let s = 0; s < 3; s += 1) {
      const meta = await store.create({ owner_id: "o", persona_id: "p", title: `s${s}` });
      sids.push(meta.session_id);
      gens.push(genHistory(0x5eed + s, meta.session_id, s === 0 ? 1000 : 500));
    }
    // interleave batches across sessions so per-session and global order differ
    const batch = 100;
    let appended = 0;
    let total = 0;
    const queues = gens.map((g) => [...g.events]);
    total = queues.reduce((acc, q) => acc + q.length, 0);
    while (appended < total) {
      for (let i = 0; i < queues.length; i += 1) {
        const queue = queues[i]!;
        const chunk = queue.splice(0, batch);
        if (chunk.length === 0) continue;
        const stored = await store.append(sids[i]!, chunk);
        expect(stored[0]?.seq).toBeGreaterThan(0);
        appended += chunk.length;
      }
    }
    for (let i = 0; i < sids.length; i += 1) {
      const g = gens[i]!;
      const p = await store.projection(sids[i]!);
      expect(p.messages).toHaveLength(g.expectedMessages);
      expect(p.tool_calls).toHaveLength(g.expectedToolCalls);
      expect(p.approvals).toHaveLength(g.expectedApprovals);
      expect(p.usage).toEqual(g.expectedUsage);
    }

    const beforeRows = snapshotRawRows(store);
    const beforeProjections = await snapshotProjections(store, sids);

    await store.rebuildProjections();

    const afterRows = snapshotRawRows(store);
    const afterProjections = await snapshotProjections(store, sids);
    // THE replay acceptance: byte-identical before and after
    expect(afterRows).toBe(beforeRows);
    expect(afterProjections).toBe(beforeProjections);

    // and the store keeps working after a rebuild
    const sid = sids[0]!;
    const stored: StoredEvent[] = await store.append(sid, [
      {
        type: "message.user",
        session_id: sid,
        turn_id: "post",
        content: [{ type: "text", text: "after rebuild" }],
        ts: Date.now(),
      },
    ]);
    const p = await store.projection(sid);
    expect(p.messages).toHaveLength(gens[0]!.expectedMessages + 1);
    expect(p.last_seq).toBe(stored[0]!.seq);
    store.close();
  });

  it("scales to 10,000 events in a file-backed store within a few seconds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyx-session-scale-"));
    tmpDirs.push(dir);
    const store = new SessionStoreImpl(join(dir, "scale.db"));
    const meta = await store.create({ owner_id: "o", persona_id: "p", title: "scale" });
    const gen = genHistory(0xca1e, meta.session_id, 10_000);

    const t0 = performance.now();
    for (let i = 0; i < gen.events.length; i += 500) {
      await store.append(meta.session_id, gen.events.slice(i, i + 500));
    }
    const tAppend = performance.now();
    await store.rebuildProjections();
    const tRebuild = performance.now();

    const p = await store.projection(meta.session_id);
    expect((await store.read(meta.session_id)).length).toBe(10_001);
    expect(p.messages).toHaveLength(gen.expectedMessages);
    expect(p.tool_calls).toHaveLength(gen.expectedToolCalls);
    expect(p.approvals).toHaveLength(gen.expectedApprovals);
    expect(p.usage.total_tokens).toBe(gen.expectedUsage.total_tokens);

    const appendMs = tAppend - t0;
    const rebuildMs = tRebuild - tAppend;
    expect(appendMs).toBeLessThan(5000); // keep the bound generous across machines
    expect(rebuildMs).toBeLessThan(5000);
    store.close();
  });
});
