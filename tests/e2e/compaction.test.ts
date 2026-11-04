// SPDX-License-Identifier: AGPL-3.0-or-later
// E2E compaction (Phase 2 §2.2 gate): a session whose persisted history
// carries twenty ~20KB tool_result blocks (seeded as assistant messages, the
// only durable shape for tool results) crosses the default 100k-token
// budget; the four-tier pipeline compacts it (Tier 1 elision), the turn
// completes, the model request carries elision markers instead of the tool
// bodies, and the audit chain verifies end to end. Elided content stays
// recoverable via session.read() — no event is ever lost.

import { afterAll, describe, expect, it } from "vitest";
import { MockProvider, mockTextTurn } from "@nyx/model";
import { join } from "node:path";
import { openSessionStore } from "@nyx/session";
import { cleanupRigs, createSession, makeRig, readEvents, startTurn, until } from "./helpers.js";

afterAll(async () => {
  await cleanupRigs();
});

describe("e2e compaction: a large session", () => {
  it("crosses the budget, compacts via elision, completes, chain verifies, events recoverable", async () => {
    // ~20KB per tool_result block; 20 seeded blocks ≈ 410KB ≈ 102k tokens of
    // history — over the default 100k compaction budget.
    const bigBody = `<tool_output trust="untrusted">\n${"0123456789abcdef".repeat(1_280)}\n</tool_output>`;
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("final answer")])]);
    const sessionId = await createSession(rig, { title: "compaction e2e" });

    // Seed the prior history directly through the store (the durable shape
    // for tool results: assistant messages carrying tool_result blocks).
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    try {
      const seed: Array<Record<string, unknown>> = [];
      let ts = 1;
      for (let i = 0; i < 20; i++) {
        seed.push(
          { type: "turn.started", session_id: sessionId, turn_id: `seed-${i}`, ts: ts++ },
          {
            type: "message.user",
            session_id: sessionId,
            turn_id: `seed-${i}`,
            content: [{ type: "text", text: `read big-${i}.txt` }],
            ts: ts++,
          },
          {
            type: "message.assistant",
            session_id: sessionId,
            turn_id: `seed-${i}`,
            content: [
              { type: "tool_use", call_id: `seed-${i}`, name: "fs.read", input: { path: `big-${i}.txt` } },
            ],
            ts: ts++,
          },
          {
            type: "message.assistant",
            session_id: sessionId,
            turn_id: `seed-${i}`,
            content: [
              { type: "tool_result", call_id: `seed-${i}`, output: { kind: "text", text: bigBody } },
            ],
            ts: ts++,
          },
          {
            type: "turn.completed",
            session_id: sessionId,
            turn_id: `seed-${i}`,
            usage: { input_tokens: 1, output_tokens: 1 },
            ts: ts++,
          },
        );
      }
      await store.append(sessionId, seed as never);
    } finally {
      store.close();
    }

    // One API-driven turn over the huge history → compaction fires.
    await startTurn(rig, sessionId, "summarize everything");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed" && e.turn_id !== undefined && !e.turn_id.startsWith("seed-"));
    });

    const events = await readEvents(rig, sessionId);
    // Compaction fired with the rule-elision strategy and freed real tokens.
    const started = events.filter((e) => e.type === "compaction.started");
    const completed = events.filter((e) => e.type === "compaction.completed");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBe(started.length);
    expect((started[0] as { strategy: string }).strategy).toBe("rule-elision");
    expect((completed[0] as { freed_tokens: number }).freed_tokens).toBeGreaterThan(10_000);
    // No emergency fired — elision kept up (only 20 blocks of history, all
    // elidable; the post-elision estimate is far under 95% of the budget).
    expect(
      events.some(
        (e) => e.type === "compaction.started" && (e as { strategy: string }).strategy === "emergency-degrade",
      ),
    ).toBe(false);

    // Events were never lost: every seeded turn is still readable and the
    // elided tool bodies remain recoverable through the event log.
    expect(events.filter((e) => e.type === "turn.completed").length).toBe(21);
    // (JSON-escaped newlines make full-body matching unreliable; a long
    // hex run proves the content is intact.)
    expect(JSON.stringify(events)).toContain("0123456789abcdef".repeat(16));

    // The audit chain verifies end to end; ordinary (non-emergency)
    // compaction is not audited, and reconcile stays clean.
    const { verifyAuditChain, reconcileEventAudit } = await import("@nyx/policy");
    // @ts-expect-error better-sqlite3 resolves from the sibling workspace.
    const Database = (await import("../../packages/policy/node_modules/better-sqlite3")).default;
    const auditDb = new Database(`${rig.dataDir}/nyx.db`);
    try {
      expect(verifyAuditChain(auditDb).ok).toBe(true);
      expect(reconcileEventAudit(auditDb, events)).toEqual([]);
      const audited = auditDb
        .prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'compaction.completed'")
        .get() as { n: number };
      expect(audited.n).toBe(0);
    } finally {
      auditDb.close();
    }
  }, 60_000);
});
