// SPDX-License-Identifier: AGPL-3.0-or-later
// E2E replay: run turns, fork at an early seq over REST, and assert the
// child's event prefix is identical (modulo the rewritten session identity
// and its fresh seq numbers) — replay/fork is free with event sourcing.

import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  cleanupRigs,
  createSession,
  makeRig,
  MockProvider,
  mockTextTurn,
  readEvents,
  startTurn,
  until,
} from "./helpers.js";

afterAll(async () => {
  await cleanupRigs();
});

describe("e2e replay", () => {
  it("fork's event prefix matches the parent's, payload-identical", async () => {
    const rig = await makeRig([
      new MockProvider("mock", [mockTextTurn("first turn"), mockTextTurn("second turn")]),
    ]);
    const sessionId = await createSession(rig, { title: "replay source" });

    await startTurn(rig, sessionId, "first");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.filter((e) => e.type === "turn.completed").length >= 1;
    });
    await startTurn(rig, sessionId, "second");
    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.filter((e) => e.type === "turn.completed").length >= 2;
    });

    const all = await readEvents(rig, sessionId);
    expect(all.length).toBeGreaterThan(8);
    const atSeq = 7; // mid-first-turn boundary

    // fork over REST at the boundary
    const forked = await rig.server.app.request(`/v1/sessions/${sessionId}/fork`, {
      method: "POST",
      headers: rig.headers,
      body: JSON.stringify({ at_seq: atSeq }),
    });
    expect(forked.status).toBe(201);
    const child = (await forked.json()) as { session_id: string; parent_id: string | null };
    expect(child.parent_id).toBe(sessionId);

    // the parent got session.forked appended
    const parentEvents = await readEvents(rig, sessionId);
    expect(parentEvents.some((e) => e.type === "session.forked")).toBe(true);

    // the child's prefix: same count, same types in order, payloads identical
    // after stripping the fields fork legitimately rewrites (session_id, seq)
    const childEvents = await readEvents(rig, child.session_id);
    expect(childEvents.length).toBe(atSeq);
    const strip = (e: Record<string, unknown>): string => {
      const { session_id: _sid, seq: _seq, ...rest } = e;
      void _sid;
      void _seq;
      return JSON.stringify(rest);
    };
    for (let i = 0; i < atSeq; i++) {
      expect(childEvents[i]!.type).toBe(all[i]!.type);
      expect(strip(childEvents[i]! as unknown as Record<string, unknown>)).toBe(
        strip(all[i]! as unknown as Record<string, unknown>),
      );
    }

    // the child is a live session: it can run its own turn
    const { openSessionStore } = await import("@nyx/session");
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    try {
      await store.append(child.session_id, [
        { type: "turn.started", session_id: child.session_id, turn_id: "t-child", ts: Date.now() },
      ]);
      // the child's copied events carry fresh global seqs; read everything
      // and assert the appended tail
      const after = await store.read(child.session_id);
      expect(after.length).toBe(atSeq + 1);
      expect(after[atSeq]!.type).toBe("turn.started");
    } finally {
      store.close();
    }
  });
});
