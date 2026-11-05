// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 0 verification item 0.1 (kept as a permanent regression test):
// append exactly 10,000 synthetic events to a file-backed store, snapshot the
// incrementally maintained projections, rebuild from the event log, and
// require byte-identical projections. Run directly via:
//   pnpm --filter @nyx/session test -- replay-10k
//
// v0.7.1: this is the canonical 10k test. The redundant scale block that
// lived in replay.test.ts (same workload, plus machine-bound timing
// assertions) was deleted; its unique ground-truth count assertions moved
// here. Timings are logged, never asserted — a wall-clock bound calibrated
// on one machine is a flakiness bug on the next (WSL2 is 3–5× slower on
// file-backed writes; see docs/TOOLING-NOTES.md).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, describe, expect, it } from "vitest";
import { mergeUsage } from "@nyx/protocol";
import type { SessionEvent, SessionStore } from "@nyx/protocol";
import { SessionStoreImpl } from "./store.js";

const COUNT = 10_000;
const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Deterministic PRNG so every run replays the same history. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Mixed synthetic history of exactly `count` events for one session. */
function genHistory(seed: number, sid: string, count: number): SessionEvent[] {
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
    push({
      type: "message.assistant",
      session_id: sid,
      turn_id: turnId,
      content: [{ type: "text", text: `answer ${turn}` }],
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
        name: pick(["fs.read", "web.fetch", "shell.exec"]),
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
          output: { kind: "text", text: "ok" },
          ts: tick(),
        });
      } else if (outcome === "error") {
        push({
          type: "tool.error",
          session_id: sid,
          turn_id: turnId,
          call_id: callId,
          error: { name: "ToolError", message: `boom ${callN}`, retryable: false },
          ts: tick(),
        });
      } else {
        push({
          type: "action.denied",
          session_id: sid,
          turn_id: turnId,
          call_id: callId,
          reason: "policy",
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
    push({
      type: "turn.completed",
      session_id: sid,
      turn_id: turnId,
      usage: { input_tokens: 100 + turn, output_tokens: 40 + turn },
      ts: tick(),
    });
    turn += 1;
  }
  return events;
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

async function snapshotProjection(store: SessionStore, sid: string): Promise<string> {
  const p = await store.projection(sid);
  return JSON.stringify({
    session_id: p.session_id,
    last_seq: p.last_seq,
    messages: p.messages,
    tool_calls: p.tool_calls,
    approvals: p.approvals,
    usage: p.usage,
  });
}

describe("replay-10k (Phase 0 verification 0.1)", () => {
  it("replays 10,000 appended events byte-identically to the incremental projections", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nyx-replay-10k-"));
    tmpDirs.push(dir);
    const store = new SessionStoreImpl(join(dir, "replay-10k.db"));
    const meta = await store.create({ owner_id: "o", persona_id: "p", title: "replay-10k" });
    const sid = meta.session_id;
    const events = genHistory(0x10c, sid, COUNT);
    expect(events).toHaveLength(COUNT);

    // Ground truth derived from the generated list (ported from the deleted
    // replay.test.ts 10k block in v0.7.1): the incremental projections are
    // held to the generator, not merely to whatever the incremental path
    // happened to produce.
    const expectedMessages = events.filter(
      (e) => e.type === "message.user" || e.type === "message.assistant",
    ).length;
    const expectedToolCalls = events.filter((e) => e.type === "tool.call").length;
    const expectedApprovals = events.filter((e) => e.type === "approval.requested").length;
    const expectedUsage = mergeUsage(
      ...events
        .filter(
          (e): e is Extract<SessionEvent, { type: "turn.completed" }> =>
            e.type === "turn.completed",
        )
        .map((e) => e.usage),
    );

    const t0 = performance.now();
    for (let i = 0; i < events.length; i += 500) {
      await store.append(sid, events.slice(i, i + 500));
    }
    const tAppend = performance.now();

    // The incremental projections match the generator's ground truth.
    const incremental = await store.projection(sid);
    expect(incremental.messages).toHaveLength(expectedMessages);
    expect(incremental.tool_calls).toHaveLength(expectedToolCalls);
    expect(incremental.approvals).toHaveLength(expectedApprovals);
    expect(incremental.usage.total_tokens).toBe(expectedUsage.total_tokens);

    // Incremental state BEFORE the rebuild — the ground truth to reproduce.
    const beforeRows = snapshotRawRows(store);
    const beforeProjection = await snapshotProjection(store, sid);

    await store.rebuildProjections();
    const tRebuild = performance.now();

    // THE acceptance: replayed state is byte-identical to incremental state.
    const afterRows = snapshotRawRows(store);
    const afterProjection = await snapshotProjection(store, sid);
    expect(afterRows).toBe(beforeRows);
    expect(afterProjection).toBe(beforeProjection);

    // The log itself holds exactly session.created + 10,000 events.
    expect((await store.read(sid)).length).toBe(COUNT + 1);

    // Keep perf observable in CI output (not an assertion).
    console.log(
      `replay-10k: append=${Math.round(tAppend - t0)}ms rebuild=${Math.round(tRebuild - tAppend)}ms`,
    );
    store.close();
  });
});
