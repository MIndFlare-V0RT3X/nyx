// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.0.1 e2e: a Phase-1-era data dir (nyx.db + policy.db + channels.db +
// heartbeat.db) migrates into the unified nyx.db when the Phase-2 server
// opens it. The audit chain carries over end to end, the legacy files are
// renamed (never deleted), and turns keep working on pre-existing sessions.

import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { configSchema, type NyxConfig } from "@nyx/config";
import { MockProvider, mockTextTurn, mockToolTurn } from "@nyx/model";
import { appendAudit, verifyAuditChain } from "@nyx/policy";
import { openSessionStore } from "@nyx/session";
import { ChannelSessionStore } from "@nyx/channels";
import { HeartbeatStore } from "@nyx/runtime";
import { createServer, type NyxServer } from "@nyx/server";
// Tests are exempt from the package import boundaries; better-sqlite3
// resolves from the sibling @nyx/policy workspace install (same trick as
// smoke.test.ts — @nyx/e2e deliberately does not declare it).
// @ts-expect-error better-sqlite3 is not a declared dependency of @nyx/e2e.
const Database = (await import("../../packages/policy/node_modules/better-sqlite3")).default;

const OWNER_TOKEN = "e2e-migration-owner-token-0123456789";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

describe("e2e 2.0.1 unified-db migration", () => {
  it("a split-DB data dir migrates on server open and keeps working", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "nyx-e2e-migrate-"));
    const sandboxRoot = await mkdtemp(join(tmpdir(), "nyx-e2e-migrate-sbx-"));
    const memoryRoot = await mkdtemp(join(tmpdir(), "nyx-e2e-migrate-mem-"));
    cleanups.push(
      async () => {
        await rm(dataDir, { recursive: true, force: true });
        await rm(sandboxRoot, { recursive: true, force: true });
        await rm(memoryRoot, { recursive: true, force: true });
      },
    );

    // ── Phase-1 layout: four files with live rows ──
    const store = openSessionStore(join(dataDir, "nyx.db"));
    const meta = await store.create({ owner_id: "owner", persona_id: "default" });
    await store.append(meta.session_id, [
      { type: "turn.started", session_id: meta.session_id, turn_id: "legacy-1", ts: 1 },
      {
        type: "tool.call",
        session_id: meta.session_id,
        turn_id: "legacy-1",
        call_id: "legacy-c1",
        name: "fs.read",
        input: { path: "/tmp/legacy.txt" },
        ts: 2,
      },
    ]);
    store.close();

    const policyDb = new Database(join(dataDir, "policy.db"));
    policyDb.exec(`CREATE TABLE approvals (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      action_digest TEXT NOT NULL, summary TEXT NOT NULL, risk TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
    )`);
    appendAudit(policyDb, {
      actor: "agent",
      action: "tool.call",
      payload: { legacy: true },
      event_seq: 3,
    });
    policyDb.close();

    const channelsDb = new Database(join(dataDir, "channels.db"));
    new ChannelSessionStore(channelsDb).put("telegram", "42", "100", "sess-legacy", 1);
    channelsDb.close();

    const hbDb = new Database(join(dataDir, "heartbeat.db"));
    const hb = new HeartbeatStore(hbDb);
    hb.saveState("memory-review", 10, 20);
    hb.close();

    // ── Phase-2 server opens the same data dir ──
    const config: NyxConfig = configSchema.parse({
      server: { host: "127.0.0.1", port: 8787, auth: { owner_token: OWNER_TOKEN, tokens: {} } },
      providers: { mock: { kind: "mock" } },
      router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
      policy: { rules: [{ id: "allow-r1", match: { risk: "R1" }, decision: "allow" }] },
      sandbox: { provider: "local", workdir_root: sandboxRoot },
      memory: { root: memoryRoot },
      persona: { default_id: "default", root: resolve(process.cwd(), "../../personas") },
    });
    const server: NyxServer = createServer({
      config,
      data_dir: dataDir,
      providers: [
        new MockProvider("mock", [
          mockToolTurn({
            call_id: "c1",
            name: "fs.write",
            input: { path: "post-migration.txt", content: "still working" },
          }),
          mockTextTurn("file written"),
        ]),
      ],
    });
    cleanups.push(() => server.close());

    const headers = { Authorization: `Bearer ${OWNER_TOKEN}`, "content-type": "application/json" };
    const health = await server.app.request("/v1/health", { headers });
    expect(health.status).toBe(200);

    // ── the migration ran ──
    const names = await readdir(dataDir);
    expect(names).toContain("nyx.db");
    expect(names.some((n) => /^policy\.db\.migrated-\d+$/.test(n))).toBe(true);
    expect(names.some((n) => /^channels\.db\.migrated-\d+$/.test(n))).toBe(true);
    expect(names.some((n) => /^heartbeat\.db\.migrated-\d+$/.test(n))).toBe(true);
    expect(existsSync(join(dataDir, "policy.db"))).toBe(false);

    // The pre-existing session still drives a turn through the full stack.
    const turnRes = await server.app.request(`/v1/sessions/${meta.session_id}/turns`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content: { text: "write the file" } }),
    });
    expect(turnRes.status).toBe(202);

    const deadline = Date.now() + 8000;
    let events: Array<{ type: string; seq?: number }> = [];
    for (;;) {
      const open = openSessionStore(join(dataDir, "nyx.db"));
      events = (await open.read(meta.session_id, 1)) as Array<{ type: string; seq?: number }>;
      open.close();
      if (events.some((e) => e.type === "turn.completed") || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(events.some((e) => e.type === "turn.completed")).toBe(true);

    // ── the chain: legacy rows carried over, db.migrated appended, and the
    // post-migration turn's tool events chained on top — all in one table. ──
    const auditDb = new Database(join(dataDir, "nyx.db"));
    try {
      const actions = (
        auditDb.prepare("SELECT action FROM audit ORDER BY id").all() as Array<{ action: string }>
      ).map((r) => r.action);
      expect(actions[0]).toBe("tool.call"); // the legacy row
      expect(actions).toContain("db.migrated");
      expect(actions.filter((a) => a === "tool.call").length).toBe(2); // legacy + new turn
      expect(actions).toContain("tool.result"); // from the post-migration turn
      const chain = verifyAuditChain(auditDb);
      expect(chain.ok).toBe(true);
      // legacy tool.call + db.migrated + this turn's tool.call + tool.result
      expect(chain.checked).toBe(4);
      expect(chain.checked).toBe(actions.length);
    } finally {
      auditDb.close();
    }
  });
});
