// SPDX-License-Identifier: AGPL-3.0-or-later
// E2E approval: an R2 tool (web.fetch, in-scope loopback target) triggers
// ask → approval.requested → owner allows → executes once → tool.result →
// approval.resolved. Then the deny variant: action.denied, no execution.
// Approvals are single-use: the resolved record cannot be resolved again.

import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupRigs,
  createSession,
  loopbackHttp,
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

function loopbackEngagement(now: number): Record<string, unknown> {
  return {
    id: "ENG-E2E",
    operator_id: "owner",
    authorized_at: now,
    expires_at: now + 3_600_000,
    targets: { cidrs: ["127.0.0.0/8"], domains: [] },
  };
}

describe("e2e scope enforcement", () => {
  it("out-of-scope egress is denied without ever asking — scope is not negotiable", async () => {
    const http = await loopbackHttp("out-of-scope-target");
    try {
      const rig = await makeRig([
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
          mockTextTurn("scope held"),
        ]),
      ]);
      // The engagement authorizes example.com ONLY; the loopback server is
      // outside scope. No approval may be created for it — deny, not ask.
      const now = Date.now();
      const sessionId = await createSession(rig, {
        engagement: {
          id: "ENG-SCOPE",
          operator_id: "owner",
          authorized_at: now,
          expires_at: now + 3_600_000,
          targets: { cidrs: [], domains: ["example.com"] },
        },
      });
      await startTurn(rig, sessionId, "fetch the loopback target");

      await until(async () => {
        const events = await readEvents(rig, sessionId);
        return events.some((e) => e.type === "turn.completed");
      });

      const events = await readEvents(rig, sessionId);
      const denial = events.find((e) => e.type === "action.denied");
      expect(denial).toMatchObject({ type: "action.denied", reason: "scope" });
      expect(JSON.stringify(denial)).toContain("not in engagement");
      // no approval was ever requested — scope denial precedes the ask path
      expect(events.some((e) => e.type === "approval.requested")).toBe(false);
      // no execution happened
      expect(events.some((e) => e.type === "tool.result")).toBe(false);
      // the turn still completed
      expect(events[events.length - 1]!.type).toBe("turn.completed");
    } finally {
      await http.close();
    }
  });

  it("no engagement at all → external egress denied, local tools unaffected", async () => {
    const http = await loopbackHttp("no-engagement");
    try {
      const rig = await makeRig([
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
          mockToolTurn({
            call_id: "c2",
            name: "fs.write",
            input: { path: "ok.txt", content: "local" },
          }),
          mockTextTurn("done"),
        ]),
      ]);
      const sessionId = await createSession(rig); // no engagement
      await startTurn(rig, sessionId, "fetch then write");

      await until(async () => {
        const events = await readEvents(rig, sessionId);
        return events.some((e) => e.type === "turn.completed");
      });

      const events = await readEvents(rig, sessionId);
      const denial = events.find((e) => e.type === "action.denied");
      expect(denial).toMatchObject({ reason: "scope" });
      expect(JSON.stringify(denial)).toContain("no engagement declared");
      // the local tool (R1, allow) executed fine after the denied fetch
      expect(events.some((e) => e.type === "tool.result")).toBe(true);
      expect(events[events.length - 1]!.type).toBe("turn.completed");
    } finally {
      await http.close();
    }
  });
});

describe("e2e approval", () => {
  it("ask → allow → executes once → resolved; the approval is single-use", async () => {
    const http = await loopbackHttp("approval-e2e-body");
    try {
      const rig = await makeRig([
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
          mockTextTurn("fetched"),
        ]),
      ]);
      const sessionId = await createSession(rig, { engagement: loopbackEngagement(Date.now()) });
      await startTurn(rig, sessionId, "fetch the target");

      // 1. the R2 verdict asks; a pending approval appears over REST
      let approvalId = "";
      await until(async () => {
        const res = await rig.server.app.request(`/v1/approvals?session_id=${sessionId}`, {
          headers: rig.headers,
        });
        const records = (await res.json()) as Array<{ id: string }>;
        approvalId = records[0]?.id ?? "";
        return approvalId !== "";
      });

      // 2. approval.requested is in the session event log
      await until(async () => {
        const events = await readEvents(rig, sessionId);
        return events.some((e) => e.type === "approval.requested");
      });

      // 3. the owner allows → the tool executes exactly once
      const allow = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
        method: "POST",
        headers: rig.headers,
        body: JSON.stringify({ decision: "allow" }),
      });
      expect(allow.status).toBe(200);

      await until(async () => {
        const events = await readEvents(rig, sessionId);
        return events.some((e) => e.type === "turn.completed");
      });

      const events = await readEvents(rig, sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("approval.requested");
      expect(types).toContain("approval.resolved");
      expect(types).toContain("tool.call");
      const toolResult = events.find((e) => e.type === "tool.result");
      expect(toolResult).toBeDefined();
      expect(JSON.stringify(toolResult)).toContain("approval-e2e-body");

      // exactly ONE tool.call — the approval authorized exactly one execution
      expect(types.filter((t) => t === "tool.call")).toHaveLength(1);

      // 4. single-use: the resolved approval cannot be resolved again
      const again = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
        method: "POST",
        headers: rig.headers,
        body: JSON.stringify({ decision: "allow" }),
      });
      expect(again.status).toBe(409);
    } finally {
      await http.close();
    }
  });

  it("ask → deny → action.denied, no execution, the turn still completes", async () => {
    const http = await loopbackHttp("never-fetched");
    try {
      const rig = await makeRig([
        new MockProvider("mock", [
          mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
          mockTextTurn("denied, moving on"),
        ]),
      ]);
      const sessionId = await createSession(rig, { engagement: loopbackEngagement(Date.now()) });
      await startTurn(rig, sessionId, "fetch it");

      let approvalId = "";
      await until(async () => {
        const res = await rig.server.app.request(`/v1/approvals?session_id=${sessionId}`, {
          headers: rig.headers,
        });
        const records = (await res.json()) as Array<{ id: string }>;
        approvalId = records[0]?.id ?? "";
        return approvalId !== "";
      });

      const deny = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
        method: "POST",
        headers: rig.headers,
        body: JSON.stringify({ decision: "deny" }),
      });
      expect(deny.status).toBe(200);

      await until(async () => {
        const events = await readEvents(rig, sessionId);
        return events.some((e) => e.type === "turn.completed");
      });

      const events = await readEvents(rig, sessionId);
      const types = events.map((e) => e.type);
      // denied: the call intent is on the record (tool.call fires before
      // enforcement), action.denied follows, and NO tool.result ever lands
      expect(types).toContain("action.denied");
      expect(types).toContain("tool.call");
      expect(types).not.toContain("tool.result");
      const deniedIdx = types.indexOf("action.denied");
      expect(types.indexOf("tool.call")).toBeLessThan(deniedIdx);
      // but the loop continued and the turn completed with the final message
      expect(types[types.length - 1]).toBe("turn.completed");
      expect(types).toContain("approval.resolved");
    } finally {
      await http.close();
    }
  });
});
