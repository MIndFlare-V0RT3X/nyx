// SPDX-License-Identifier: AGPL-3.0-or-later
// Server behavior tests through Hono's app.request() (no port): auth, health,
// sessions, SSE framing + resume, full turn execution against an injected
// scripted mock provider, the approval lifecycle over REST, R4 owner-binding,
// fork, and the one-turn-at-a-time guard.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "http";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { configSchema, type NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn, mockToolTurn } from "@nyx/model";
import type { ModelProvider } from "@nyx/protocol";
import { createServer as createNyxServer, type NyxServer } from "./server.js";
import Database from "better-sqlite3";

const OWNER_TOKEN = "test-owner-token-0123456789";
const GUEST_TOKEN = "test-guest-token-0123456789";

const RULES = [
  { id: "allow-r0", match: { risk: "R0" as const }, decision: "allow" as const },
  { id: "allow-r1", match: { risk: "R1" as const }, decision: "allow" as const },
  { id: "ask-r2", match: { risk: "R2" as const }, decision: "ask" as const },
  { id: "ask-r3", match: { risk: "R3" as const }, decision: "ask" as const },
  { id: "ask-r4", match: { risk: "R4" as const }, decision: "ask" as const },
];

interface Rig {
  server: NyxServer;
  dataDir: string;
  sandboxRoot: string;
  memoryRoot: string;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

function buildConfig(overrides: Record<string, unknown> = {}): NyxConfig {
  return configSchema.parse({
    server: {
      host: "127.0.0.1",
      port: 8787,
      auth: { owner_token: OWNER_TOKEN, tokens: { guest: GUEST_TOKEN } },
    },
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: { rules: RULES },
    sandbox: { provider: "local" },
    ...overrides,
  });
}

async function makeRig(
  providers?: ModelProvider[],
  overrides: Record<string, unknown> = {},
  serverDeps: {
    engagement_resolver?: (host: string) => Promise<Array<{ address: string; family: number }>>;
  } = {},
): Promise<Rig> {
  const dataDir = await mkdtemp(join(tmpdir(), "nyx-server-data-"));
  const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-server-sbx-"));
  const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-server-mem-"));
  const config = buildConfig({
    sandbox: { provider: "local", workdir_root: sandboxRoot },
    memory: { root: memoryRoot },
    persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
    ...overrides,
  });
  const server = createNyxServer({
    config,
    data_dir: dataDir,
    ...(providers !== undefined ? { providers } : {}),
    ...(serverDeps.engagement_resolver !== undefined
      ? { engagement_resolver: serverDeps.engagement_resolver }
      : {}),
  });
  const rig: Rig = {
    server,
    dataDir,
    sandboxRoot,
    memoryRoot,
    close: () => server.close(),
  };
  rigs.push(rig);
  return rig;
}

afterAll(async () => {
  for (const rig of rigs) await rig.close();
  for (const rig of rigs) {
    await rm(rig.dataDir, { recursive: true, force: true });
    await rm(rig.sandboxRoot, { recursive: true, force: true });
    await rm(rig.memoryRoot, { recursive: true, force: true });
  }
});

function ownerHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${OWNER_TOKEN}`, "Content-Type": "application/json" };
}
function guestHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${GUEST_TOKEN}`, "Content-Type": "application/json" };
}

async function until(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("condition not met in time");
}

/** Every stored event for a session, in seq order, via the session store. */
async function readEvents(rig: Rig, sessionId: string) {
  const { openSessionStore } = await import("@nyx/session");
  const store = openSessionStore(join(rig.dataDir, "nyx.db"));
  try {
    return await store.read(sessionId, 1);
  } finally {
    store.close();
  }
}

/** Spin a loopback HTTP server; returns { url, close }. */
async function loopbackServer(body: string): Promise<{ url: string; close(): Promise<void> }> {
  const srv: HttpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((resolvePromise) => srv.listen(0, "127.0.0.1", resolvePromise));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/target.txt`,
    close: () => new Promise<void>((resolvePromise) => srv.close(() => resolvePromise())),
  };
}

describe("auth + health", () => {
  it("health is public and reports sandbox + providers", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const res = await rig.server.app.request("/v1/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      sandbox: { provider: string };
      providers: Array<{ id: string }>;
    };
    expect(body.status).toBe("ok");
    expect(body.sandbox.provider).toBe("local");
    expect(body.providers.map((p) => p.id)).toContain("mock");
  });

  it("rejects missing/invalid bearer tokens on protected routes", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const noAuth = await rig.server.app.request("/v1/sessions");
    expect(noAuth.status).toBe(401);
    const badAuth = await rig.server.app.request("/v1/sessions", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(badAuth.status).toBe(401);
    const good = await rig.server.app.request("/v1/sessions", { headers: ownerHeaders() });
    expect(good.status).toBe(200);
  });
});

describe("sessions", () => {
  it("creates a session; engagement round-trips; invalid targets are a 400", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const res = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ title: "test session" }),
    });
    expect(res.status).toBe(201);
    const meta = (await res.json()) as { session_id: string; persona_id: string; title: string };
    expect(meta.persona_id).toBe("default");
    expect(meta.title).toBe("test session");

    const withEngagement = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        engagement: {
          id: "ENG-1",
          operator_id: "owner",
          authorized_at: 1000,
          expires_at: Date.now() + 3_600_000,
          targets: { cidrs: ["127.0.0.0/8"], domains: ["example.com"] },
        },
      }),
    });
    expect(withEngagement.status).toBe(201);
    const meta2 = (await withEngagement.json()) as { engagement: { id: string } | null };
    expect(meta2.engagement?.id).toBe("ENG-1");

    const bad = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        engagement: {
          id: "ENG-2",
          operator_id: "owner",
          authorized_at: 1000,
          expires_at: Date.now() + 3_600_000,
          targets: { cidrs: ["not-a-cidr"], domains: [] },
        },
      }),
    });
    expect(bad.status).toBe(400);
    const errBody = (await bad.json()) as { error: { message: string } };
    expect(errBody.error.message).toContain("invalid CIDR");

    // Phase 1 hardening 2.3: an engagement from a different operator is a
    // hard 400 naming both ids, never silently bound to this owner's session.
    const foreignEngagement = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        engagement: {
          id: "ENG-3",
          operator_id: "someone-else",
          authorized_at: 1000,
          expires_at: Date.now() + 3_600_000,
          targets: { cidrs: ["127.0.0.0/8"], domains: [] },
        },
      }),
    });
    expect(foreignEngagement.status).toBe(400);
    const foreignBody = (await foreignEngagement.json()) as {
      error: { code: string; message: string };
    };
    expect(foreignBody.error.code).toBe("engagement_ownership");
    expect(foreignBody.error.message).toContain("someone-else");
    expect(foreignBody.error.message).toContain("owner");

    const unknownPersona = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ persona_id: "does-not-exist" }),
    });
    expect(unknownPersona.status).toBe(400);
  });

  it("GET /v1/sessions/:id returns meta + projection; 404 for unknown", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{}",
    });
    const meta = (await created.json()) as { session_id: string };

    const got = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
      headers: ownerHeaders(),
    });
    expect(got.status).toBe(200);
    const body = (await got.json()) as {
      session: { session_id: string };
      projection: { messages: unknown[] };
    };
    expect(body.session.session_id).toBe(meta.session_id);
    expect(Array.isArray(body.projection.messages)).toBe(true);

    const missing = await rig.server.app.request("/v1/sessions/nope", { headers: ownerHeaders() });
    expect(missing.status).toBe(404);
  });
});

describe("engagement creation audit (2.0.4)", () => {
  const fakeResolver = async (host: string) =>
    host === "example.com"
      ? [
          { address: "93.184.216.34", family: 4 },
          { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
        ]
      : [];

  it("a domain-only engagement writes an engagement.created row with the initial resolution", async () => {
    const rig = await makeRig(
      [new MockProvider("mock", [mockTextTurn("x")])],
      {},
      { engagement_resolver: fakeResolver },
    );
    const res = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        engagement: {
          id: "ENG-domain-only",
          operator_id: "owner",
          authorized_at: Date.now(),
          expires_at: Date.now() + 3_600_000,
          targets: { domains: ["example.com"], cidrs: [] }, // domain-only: empty cidrs
        },
      }),
    });
    if (res.status !== 201) throw new Error(`session create failed: ${await res.text()}`);
    const meta = (await res.json()) as { session_id: string };

    const { verifyAuditChain } = await import("@nyx/policy");
    const db = new Database(join(rig.dataDir, "nyx.db"));
    try {
      const rows = db
        .prepare(
          "SELECT actor, action, payload_json FROM audit WHERE action = 'engagement.created'",
        )
        .all() as Array<{ actor: string; action: string; payload_json: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("owner");
      const payload = JSON.parse(rows[0]!.payload_json) as {
        session_id: string;
        domain_only: boolean;
        domains: Array<{ domain: string; resolved_ips: string[] }>;
        warning: string;
      };
      expect(payload.session_id).toBe(meta.session_id);
      expect(payload.domain_only).toBe(true);
      expect(payload.domains[0]!.domain).toBe("example.com");
      expect(payload.domains[0]!.resolved_ips).toEqual([
        "93.184.216.34",
        "2606:2800:220:1:248:1893:25c8:1946",
      ]);
      expect(typeof payload.warning).toBe("string");
      expect(verifyAuditChain(db).ok).toBe(true);
    } finally {
      db.close();
    }
  });

  it("a CIDR-constrained engagement writes a row noting the constraint", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const res = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({
        engagement: {
          id: "ENG-cidr",
          operator_id: "owner",
          authorized_at: Date.now(),
          expires_at: Date.now() + 3_600_000,
          targets: { cidrs: ["93.184.0.0/16"], domains: ["example.com"] },
        },
      }),
    });
    expect(res.status).toBe(201);
    const db = new Database(join(rig.dataDir, "nyx.db"));
    try {
      const payload = JSON.parse(
        (
          db
            .prepare("SELECT payload_json FROM audit WHERE action = 'engagement.created'")
            .get() as { payload_json: string }
        ).payload_json,
      ) as { domain_only: boolean; cidrs: string[]; note: string };
      expect(payload.domain_only).toBe(false);
      expect(payload.cidrs).toEqual(["93.184.0.0/16"]);
      expect(typeof payload.note).toBe("string");
    } finally {
      db.close();
    }
  });

  it("sessions without engagements write no engagement row", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const res = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ title: "no engagement" }),
    });
    expect(res.status).toBe(201);
    const db = new Database(join(rig.dataDir, "nyx.db"));
    try {
      const n = (
        db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'engagement.created'").get() as {
          n: number;
        }
      ).n;
      expect(n).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("turns (mock provider, full loop)", () => {
  it("runs a tool round: fs.write executes (R1 allow) and the turn completes", async () => {
    const provider = new MockProvider("mock", [
      mockToolTurn({
        call_id: "c1",
        name: "fs.write",
        input: { path: "note.txt", content: "hello nyx" },
      }),
      mockTextTurn("note written"),
    ]);
    const rig = await makeRig([provider]);

    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{}",
    });
    const meta = (await created.json()) as { session_id: string };

    const turnRes = await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ content: { text: "write a note" } }),
    });
    expect(turnRes.status).toBe(202);
    const { turn_id } = (await turnRes.json()) as { turn_id: string };
    expect(turn_id).toBeTruthy();

    await until(async () => {
      const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
        headers: ownerHeaders(),
      });
      const body = (await detail.json()) as {
        projection: {
          tool_calls: Array<{ status: string }>;
          messages: Array<{ role: string }>;
        };
      };
      const completed = body.projection.messages.some(
        (m) => m.role === "assistant" && JSON.stringify(m).includes("note written"),
      );
      return completed && body.projection.tool_calls.length === 1;
    });

    const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
      headers: ownerHeaders(),
    });
    const body = (await detail.json()) as {
      projection: { tool_calls: Array<{ status: string; name: string }> };
    };
    expect(body.projection.tool_calls[0]).toMatchObject({ status: "ok", name: "fs.write" });

    // the file landed inside the session's sandbox workdir (the local
    // provider mkdtemps a "nyx-sbx-*" directory under its root)
    const { readFile, readdir } = await import("node:fs/promises");
    const sandboxes = await readdir(rig.sandboxRoot);
    expect(sandboxes.length).toBeGreaterThanOrEqual(1);
    const written = await readFile(join(rig.sandboxRoot, sandboxes[0]!, "note.txt"), "utf8");
    expect(written).toBe("hello nyx");
  });

  it("a second turn while one is in flight queues in the lane and runs FIFO (approval-blocked)", async () => {
    const http = await loopbackServer("loopback body");
    try {
      const provider = new MockProvider("mock", [
        mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
        mockTextTurn("done"),
        mockTextTurn("second turn done"), // the queued turn's completion
      ]);
      const rig = await makeRig([provider]);
      const created = await rig.server.app.request("/v1/sessions", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({
          engagement: {
            id: "ENG-loop",
            operator_id: "owner",
            authorized_at: Date.now(),
            expires_at: Date.now() + 3_600_000,
            targets: { cidrs: ["127.0.0.0/8"], domains: [] },
          },
        }),
      });
      const meta = (await created.json()) as { session_id: string };

      const first = await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "fetch it" } }),
      });
      expect(first.status).toBe(202);

      // web.fetch is R2 → ask: the turn stays busy until resolved.
      let approvalId = "";
      await until(async () => {
        const pending = await rig.server.app.request(
          `/v1/approvals?session_id=${meta.session_id}`,
          {
            headers: ownerHeaders(),
          },
        );
        const records = (await pending.json()) as Array<{ id: string }>;
        approvalId = records[0]?.id ?? "";
        return approvalId !== "";
      });

      const concurrent = await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "another turn" } }),
      });
      // Phase 1 lane queue: a second turn while one is in flight no longer
      // 409s — it QUEUES in the session's lane and runs when the first
      // finishes (FIFO, serial per session).
      expect(concurrent.status).toBe(202);
      const queuedBody = (await concurrent.json()) as { turn_id: string; lane: { depth: number } };
      expect(queuedBody.turn_id).not.toBe("");
      expect(queuedBody.lane.depth).toBeGreaterThanOrEqual(1);

      // resolve → turn 1 finishes → turn 2 (the queued one) runs to completion
      const resolved = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ decision: "allow" }),
      });
      expect(resolved.status).toBe(200);

      await until(async () => {
        const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
          headers: ownerHeaders(),
        });
        const body = (await detail.json()) as {
          projection: { tool_calls: Array<{ status: string }> };
        };
        return body.projection.tool_calls[0]?.status === "ok";
      });
      const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
        headers: ownerHeaders(),
      });
      const body = (await detail.json()) as {
        projection: { tool_calls: Array<{ output: unknown }> };
      };
      expect(JSON.stringify(body.projection.tool_calls[0]?.output)).toContain("loopback body");

      // And the queued turn really ran afterwards (FIFO): its completion
      // lands after the first turn's.
      await until(async () => {
        const events = await readEvents(rig, meta.session_id);
        return (
          events.filter((e) => e.type === "turn.completed").length >= 2 &&
          events.some((e) => e.type === "turn.started" && e.turn_id === queuedBody.turn_id)
        );
      });
    } finally {
      await http.close();
    }
  });

  it("DELETE /v1/sessions/:id/turns aborts the running turn, clears that session's queue only (2.0.2)", async () => {
    const http = await loopbackServer("loopback body");
    try {
      const provider = new MockProvider("mock", [
        mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
        mockTextTurn("session B ok"), // session B's turn (runs in its own lane)
        mockTextTurn("after abort"), // session A's post-abort turn
      ]);
      const rig = await makeRig([provider]);
      const created = await rig.server.app.request("/v1/sessions", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({
          engagement: {
            id: "ENG-abort",
            operator_id: "owner",
            authorized_at: Date.now(),
            expires_at: Date.now() + 3_600_000,
            targets: { cidrs: ["127.0.0.0/8"], domains: [] },
          },
        }),
      });
      const sessionA = ((await created.json()) as { session_id: string }).session_id;
      // Session B exists but its turn is POSTed only after A's turn is
      // approval-blocked (the mock script is consumed in call order).
      const createdB = await rig.server.app.request("/v1/sessions", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ title: "B" }),
      });
      const sessionB = ((await createdB.json()) as { session_id: string }).session_id;

      // Session A: turn 1 blocks on the R2 ask verdict (web.fetch).
      const first = await rig.server.app.request(`/v1/sessions/${sessionA}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "fetch it" } }),
      });
      expect(first.status).toBe(202);
      await until(async () => {
        const pending = await rig.server.app.request(`/v1/approvals?session_id=${sessionA}`, {
          headers: ownerHeaders(),
        });
        const records = (await pending.json()) as Array<{ id: string }>;
        return records.length > 0;
      });

      // Session B runs a normal turn in parallel (its own lane).
      const turnB = await rig.server.app.request(`/v1/sessions/${sessionB}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "hello B" } }),
      });
      expect(turnB.status).toBe(202);

      // Two more turns queue behind the approval-blocked one.
      const queuedIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const res = await rig.server.app.request(`/v1/sessions/${sessionA}/turns`, {
          method: "POST",
          headers: ownerHeaders(),
          body: JSON.stringify({ content: { text: `queued ${i}` } }),
        });
        expect(res.status).toBe(202);
        queuedIds.push(((await res.json()) as { turn_id: string }).turn_id);
      }

      // DELETE aborts the running (approval-blocked) turn and clears the two
      // queued ones — for THIS session only.
      const abortRes = await rig.server.app.request(`/v1/sessions/${sessionA}/turns`, {
        method: "DELETE",
        headers: ownerHeaders(),
      });
      expect(abortRes.status).toBe(200);
      expect(await abortRes.json()).toEqual({ aborted_running: true, cleared_queued: 2 });

      // The aborted turn's events end with turn.failed reason "aborted".
      await until(async () => {
        const events = await readEvents(rig, sessionA);
        return events.some((e) => e.type === "turn.failed");
      });
      const eventsA = await readEvents(rig, sessionA);
      const last = eventsA[eventsA.length - 1]!;
      expect(last.type).toBe("turn.failed");
      expect((last as { error: { code?: string } }).error.code).toBe("aborted");

      // The queued turns never started (no turn.started for them).
      for (const qid of queuedIds) {
        expect(eventsA.some((e) => e.type === "turn.started" && e.turn_id === qid)).toBe(false);
      }

      // The pending approval was withdrawn (no orphan): resolved deny by
      // system:withdrawn, and the pending list is empty afterwards.
      const pendingAfter = await rig.server.app.request(`/v1/approvals?session_id=${sessionA}`, {
        headers: ownerHeaders(),
      });
      expect(((await pendingAfter.json()) as Array<unknown>).length).toBe(0);

      // Session B was unaffected: its turn completed normally.
      await until(async () => {
        const eventsB = await readEvents(rig, sessionB);
        return eventsB.some((e) => e.type === "turn.completed");
      });

      // The aborted session's lane is reusable: a fresh turn runs to completion.
      const after = await rig.server.app.request(`/v1/sessions/${sessionA}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "still alive?" } }),
      });
      expect(after.status).toBe(202);
      await until(async () => {
        const events = await readEvents(rig, sessionA);
        return events.some((e) => e.type === "turn.completed");
      });
    } finally {
      await http.close();
    }
  });

  it("DELETE on an idle session is a no-op reporting zeros", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ title: "idle" }),
    });
    const sid = ((await created.json()) as { session_id: string }).session_id;
    const res = await rig.server.app.request(`/v1/sessions/${sid}/turns`, {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ aborted_running: false, cleared_queued: 0 });
    const unknown = await rig.server.app.request("/v1/sessions/does-not-exist/turns", {
      method: "DELETE",
      headers: ownerHeaders(),
    });
    expect(unknown.status).toBe(404);
  });

  it("100 turns POSTed to one session execute in FIFO order (event seq monotonicity)", async () => {
    const provider = new MockProvider(
      "mock",
      Array.from({ length: 100 }, (_, i) => mockTextTurn(`reply-${i}`)),
    );
    const rig = await makeRig([provider]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ title: "lane fifo" }),
    });
    const meta = (await created.json()) as { session_id: string };

    const turnIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const res = await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: `msg-${i}` } }),
      });
      expect(res.status).toBe(202);
      turnIds.push(((await res.json()) as { turn_id: string }).turn_id);
    }

    await until(async () => {
      const events = await readEvents(rig, meta.session_id);
      return events.filter((e) => e.type === "turn.completed").length === 100;
    }, 60_000);

    const events = await readEvents(rig, meta.session_id);
    // turn.started events appear in exactly the submission order.
    const startedOrder = events.filter((e) => e.type === "turn.started").map((e) => e.turn_id);
    expect(startedOrder).toEqual(turnIds);
    // Global seq is monotonic across the whole log (store guarantee) and the
    // session executed strictly serially: turn N's completion precedes turn
    // N+1's start.
    const seqs = events.map((e) => e.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    for (let i = 1; i < 100; i++) {
      const prevDone = events.find(
        (e) => e.type === "turn.completed" && e.turn_id === turnIds[i - 1],
      );
      const thisStart = events.find((e) => e.type === "turn.started" && e.turn_id === turnIds[i]);
      expect(prevDone).toBeDefined();
      expect(thisStart).toBeDefined();
      expect(prevDone!.seq).toBeLessThan(thisStart!.seq);
    }
  });
});

describe("approvals", () => {
  it("deny path: action.denied reason approval, no tool.result", async () => {
    const http = await loopbackServer("secret body");
    try {
      const provider = new MockProvider("mock", [
        mockToolTurn({ call_id: "c1", name: "web.fetch", input: { url: http.url } }),
        mockTextTurn("after denial"),
      ]);
      const rig = await makeRig([provider]);
      const created = await rig.server.app.request("/v1/sessions", {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({
          engagement: {
            id: "ENG-deny",
            operator_id: "owner",
            authorized_at: Date.now(),
            expires_at: Date.now() + 3_600_000,
            targets: { cidrs: ["127.0.0.0/8"], domains: [] },
          },
        }),
      });
      const meta = (await created.json()) as { session_id: string };
      await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ content: { text: "fetch" } }),
      });

      let approvalId = "";
      await until(async () => {
        const pending = await rig.server.app.request(
          `/v1/approvals?session_id=${meta.session_id}`,
          {
            headers: ownerHeaders(),
          },
        );
        const records = (await pending.json()) as Array<{ id: string }>;
        approvalId = records[0]?.id ?? "";
        return approvalId !== "";
      });

      const denied = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
        method: "POST",
        headers: ownerHeaders(),
        body: JSON.stringify({ decision: "deny" }),
      });
      expect(denied.status).toBe(200);

      await until(async () => {
        const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
          headers: ownerHeaders(),
        });
        const body = (await detail.json()) as {
          projection: { tool_calls: Array<{ status: string }> };
        };
        return body.projection.tool_calls[0]?.status === "denied";
      });
    } finally {
      await http.close();
    }
  });

  it("R4 approvals are owner-only: guest gets 403, owner resolves", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("x")])]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{}",
    });
    const meta = (await created.json()) as { session_id: string };

    // Seed a pending R4 approval directly through the engine.
    const pending = rig.server.approvals.request(
      {
        decision: "ask",
        rule_id: "invariant:r4-owner-approval",
        action_digest: "d-r4-test",
        summary: '"deploy" on {"target":"prod"} [risk R4]',
      },
      { session_id: meta.session_id, turn_id: "t-r4", actor_id: "agent" },
    );

    let approvalId = "";
    await until(async () => {
      const list = await rig.server.app.request(`/v1/approvals?session_id=${meta.session_id}`, {
        headers: ownerHeaders(),
      });
      const records = (await list.json()) as Array<{ id: string }>;
      approvalId = records[0]?.id ?? "";
      return approvalId !== "";
    });

    const asGuest = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
      method: "POST",
      headers: guestHeaders(),
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(asGuest.status).toBe(403);

    const asOwner = await rig.server.app.request(`/v1/approvals/${approvalId}`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ decision: "allow" }),
    });
    expect(asOwner.status).toBe(200);
    await expect(pending).resolves.toBe("allow");
  });
});

describe("SSE + fork", () => {
  it("SSE frames events in order with seq ids; resume honors from_seq", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("hi")])]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{}",
    });
    const meta = (await created.json()) as { session_id: string };
    await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ content: { text: "hello" } }),
    });
    await until(async () => {
      const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
        headers: ownerHeaders(),
      });
      const body = (await detail.json()) as { projection: { messages: Array<{ role: string }> } };
      return body.projection.messages.some((m) => m.role === "assistant");
    });

    // Read the finite prefix through the SSE endpoint, then cancel.
    const res = await rig.server.app.request(`/v1/sessions/${meta.session_id}/events?from_seq=0`, {
      headers: ownerHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const frames: Array<{ id: string; data: string }> = [];
    const readUntil = async (count: number): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const idMatch = /^id: (.+)$/m.exec(frame);
          const dataMatch = /^data: (.+)$/m.exec(frame);
          if (idMatch !== null && dataMatch !== null) {
            frames.push({ id: idMatch[1]!, data: dataMatch[1]! });
            if (frames.length >= count) return;
          }
        }
      }
    };
    await readUntil(7); // session.created, turn.started, message.user, 2 deltas, message.assistant, turn.completed
    await reader.cancel();

    expect(frames.length).toBeGreaterThanOrEqual(5);
    expect(Number(frames[0]!.id)).toBe(1);
    const seqs = frames.map((f) => Number(f.id));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    const first = JSON.parse(frames[0]!.data) as { type: string };
    expect(first.type).toBe("session.created");
    expect(frames.some((f) => JSON.parse(f.data).type === "turn.completed")).toBe(true);

    // Resume from the middle: the first frame must carry the expected seq.
    const resumeFrom = seqs[2]!;
    const res2 = await rig.server.app.request(
      `/v1/sessions/${meta.session_id}/events?from_seq=${resumeFrom}`,
      { headers: ownerHeaders() },
    );
    const reader2 = res2.body!.getReader();
    const { value: chunk } = await reader2.read();
    await reader2.cancel();
    const text = decoder.decode(chunk);
    const firstId = Number(/^id: (.+)$/m.exec(text)?.[1]);
    expect(firstId).toBe(resumeFrom + 1);
  });

  it("fork produces a child whose event prefix is identical", async () => {
    const rig = await makeRig([new MockProvider("mock", [mockTextTurn("one")])]);
    const created = await rig.server.app.request("/v1/sessions", {
      method: "POST",
      headers: ownerHeaders(),
      body: "{}",
    });
    const meta = (await created.json()) as { session_id: string };
    await rig.server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ content: { text: "hello" } }),
    });
    await until(async () => {
      const detail = await rig.server.app.request(`/v1/sessions/${meta.session_id}`, {
        headers: ownerHeaders(),
      });
      const body = (await detail.json()) as { projection: { messages: Array<{ role: string }> } };
      return body.projection.messages.some((m) => m.role === "assistant");
    });

    const forked = await rig.server.app.request(`/v1/sessions/${meta.session_id}/fork`, {
      method: "POST",
      headers: ownerHeaders(),
      body: JSON.stringify({ at_seq: 4 }),
    });
    expect(forked.status).toBe(201);
    const child = (await forked.json()) as { session_id: string; parent_id: string | null };
    expect(child.parent_id).toBe(meta.session_id);

    const parentEvents = (await (
      await rig.server.app.request(`/v1/sessions/${meta.session_id}`, { headers: ownerHeaders() })
    ).json()) as unknown;
    void parentEvents;

    const { openSessionStore } = await import("@nyx/session");
    const store = openSessionStore(join(rig.dataDir, "nyx.db"));
    try {
      const parent = await store.read(meta.session_id, 1, 4);
      const childEvents = await store.read(child.session_id, 1, 4);
      expect(childEvents.length).toBe(parent.length);
      const strip = (e: { session_id?: string; seq?: number }) => {
        const { session_id: _sid, seq: _seq, ...rest } = e;
        void _sid;
        void _seq;
        return JSON.stringify(rest);
      };
      for (let i = 0; i < parent.length; i++) {
        expect(childEvents[i]!.type).toBe(parent[i]!.type);
        expect(strip(childEvents[i]!)).toBe(strip(parent[i]!));
      }
    } finally {
      store.close();
    }
  });
});
