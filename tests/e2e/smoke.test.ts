// SPDX-License-Identifier: AGPL-3.0-or-later
// E2E smoke: create a session, run a turn with a tool call through the REAL
// stack (server → agent loop → tool runtime → local sandbox → session store),
// and assert the exact durable event order. Fully offline (mock provider).

import { afterAll, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanupRigs,
  createSession,
  makeRig,
  MockProvider,
  mockTextTurn,
  mockToolTurn,
  readEvents,
  startTurn,
  until,
} from "./helpers.js";

afterAll(async () => {
  await cleanupRigs();
});

describe("e2e smoke", () => {
  it("create → turn with a tool call → exact event order + file side effect", async () => {
    const rig = await makeRig([
      new MockProvider("mock", [
        mockToolTurn({
          call_id: "c1",
          name: "fs.write",
          input: { path: "e2e.txt", content: "written by e2e" },
        }),
        mockTextTurn("file written"),
      ]),
    ]);

    const sessionId = await createSession(rig, { title: "e2e smoke" });
    const turnId = await startTurn(rig, sessionId, "write the file");
    expect(turnId).toBeTruthy();

    await until(async () => {
      const events = await readEvents(rig, sessionId);
      return events.some((e) => e.type === "turn.completed");
    });

    const events = await readEvents(rig, sessionId);
    const types = events.map((e) => e.type);
    // The durable order: everything appended before it was yielded.
    expect(types[0]).toBe("session.created");
    expect(types[1]).toBe("turn.started");
    expect(types[2]).toBe("message.user");
    expect(types.indexOf("message.assistant")).toBeGreaterThan(2);
    expect(types).toContain("tool.call");
    expect(types).toContain("tool.result");
    expect(types).toContain("text.delta");
    expect(types[types.length - 1]).toBe("turn.completed");

    // tool.call precedes tool.result; the assistant tool_use message
    // precedes the dispatch, the final text message follows the result.
    const toolCallIdx = types.indexOf("tool.call");
    const toolResultIdx = types.indexOf("tool.result");
    expect(toolCallIdx).toBeLessThan(toolResultIdx);
    const lastAssistant = types.lastIndexOf("message.assistant");
    expect(lastAssistant).toBeGreaterThan(toolResultIdx);

    // deltas always precede their message.assistant
    const firstDelta = types.indexOf("text.delta");
    expect(firstDelta).toBeLessThan(lastAssistant);

    // the fs.write (R1 → allow) really wrote inside the session sandbox
    const sandboxes = await readdir(rig.sandboxRoot);
    expect(sandboxes.length).toBe(1);
    const written = await readFile(join(rig.sandboxRoot, sandboxes[0]!, "e2e.txt"), "utf8");
    expect(written).toBe("written by e2e");

    // usage recorded on the completed turn
    const completed = events.find((e) => e.type === "turn.completed");
    expect(completed).toMatchObject({
      type: "turn.completed",
      usage: { output_tokens: expect.any(Number) },
    });

    // Tool events landed in the hash-chained audit log (Phase 1 hardening
    // 2.2): the server's EventSink routes every stored tool.call /
    // tool.result / tool.error / action.denied into policy.db's audit chain
    // with its event seq, so the operator can prove what the agent did, not
    // only what they approved.
    const { verifyAuditChain, reconcileEventAudit } = await import("@nyx/policy");
    // @ts-expect-error better-sqlite3 is not a declared dependency of @nyx/e2e; tests resolve it from the sibling @nyx/policy workspace.
    const Database = (await import("../../packages/policy/node_modules/better-sqlite3")).default;
    const auditDb = new Database(join(rig.dataDir, "policy.db"));
    try {
      const chain = verifyAuditChain(auditDb);
      expect(chain.ok).toBe(true);
      expect(chain.checked).toBeGreaterThan(0);
      expect(reconcileEventAudit(auditDb, events)).toEqual([]);
      const toolRows = auditDb
        .prepare(
          "SELECT action, event_seq FROM audit WHERE event_seq IS NOT NULL ORDER BY event_seq",
        )
        .all() as Array<{ action: string; event_seq: number }>;
      expect(toolRows).toEqual([
        { action: "tool.call", event_seq: events.find((e) => e.type === "tool.call")!.seq },
        { action: "tool.result", event_seq: events.find((e) => e.type === "tool.result")!.seq },
      ]);
    } finally {
      auditDb.close();
    }
  });
});
