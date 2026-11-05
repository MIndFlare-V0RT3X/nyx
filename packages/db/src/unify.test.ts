// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.0.1 acceptance: the split-DB layout (nyx.db + policy.db + channels.db +
// heartbeat.db) migrates into ONE nyx.db with the audit chain preserved end
// to end; a chain that does not verify aborts the migration and leaves the
// originals intact; legacy files are renamed, never deleted.

import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { appendAudit, openApprovalEngine, verifyAuditChain } from "@nyx/policy";
import { openSessionStore } from "@nyx/session";
import { ChannelSessionStore } from "@nyx/channels";
import { HeartbeatStore } from "@nyx/runtime";
import { openUnifiedDatabase } from "./unify.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nyx-db-unify-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Build a realistic Phase-1 split layout: 4 files, live rows in each. */
async function buildSplitLayout(root: string): Promise<{
  auditRows: number;
  lastAuditHash: string;
}> {
  mkdirSync(root, { recursive: true });
  // nyx.db — session store with a session, events, and an approvals projection.
  const store = openSessionStore(join(root, "nyx.db"));
  const meta = await store.create({ owner_id: "owner", persona_id: "default" });
  await store.append(meta.session_id, [
    {
      type: "turn.started",
      session_id: meta.session_id,
      turn_id: "t1",
      ts: 1,
    },
  ]);
  store.close();

  // policy.db — engine table under its legacy name + a real audit chain.
  const policyDb = new Database(join(root, "policy.db"));
  policyDb.exec(`CREATE TABLE approvals (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL,
    action_digest TEXT NOT NULL, summary TEXT NOT NULL, risk TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending', decided_by TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
  )`);
  policyDb
    .prepare(
      `INSERT INTO approvals
         (id, session_id, turn_id, action_digest, summary, risk, decision, decided_by, created_at, expires_at, used_at)
       VALUES ('appr_legacy_1', ?, 't1', 'digest-1', 'fs.write on /tmp/x [risk R2]', 'R2', 'pending', NULL, 1, 9999999999999, NULL)`,
    )
    .run(meta.session_id);
  appendAudit(policyDb, { actor: "agent", action: "tool.call", payload: { a: 1 }, event_seq: 2 });
  appendAudit(policyDb, { actor: "agent", action: "tool.result", payload: { b: 2 }, event_seq: 3 });
  appendAudit(policyDb, {
    actor: "owner",
    action: "approval.resolved",
    payload: { c: 3 },
  });
  const lastAuditHash = (
    policyDb.prepare("SELECT hash FROM audit ORDER BY id DESC LIMIT 1").get() as { hash: string }
  ).hash;
  policyDb.close();

  // channels.db — one conversation mapping.
  const channelsDb = new Database(join(root, "channels.db"));
  const channelStore = new ChannelSessionStore(channelsDb);
  channelStore.put("telegram", "12345", "777", "sess-chan-1", 42);
  channelsDb.close();

  // heartbeat.db — one spec's state + history.
  const hbDb = new Database(join(root, "heartbeat.db"));
  const hbStore = new HeartbeatStore(hbDb);
  hbStore.saveState("memory-review", 1000, 2000);
  hbStore.record("memory-review", 1000, "fired", "schedule");
  hbDb.close();

  return { auditRows: 3, lastAuditHash };
}

async function listDir(root: string): Promise<string[]> {
  return (await readdir(root)).sort();
}

describe("2.0.1 unified database migration", () => {
  it("opens fresh with no legacy files and no migration", () => {
    const root = join(dir, "fresh");
    const unified = openUnifiedDatabase(join(root, "nyx.db"));
    expect(unified.migratedLegacyFiles).toEqual([]);
    unified.close();
    // Reopen: still nothing to migrate.
    const again = openUnifiedDatabase(join(root, "nyx.db"));
    expect(again.migratedLegacyFiles).toEqual([]);
    again.close();
  });

  it("migrates the split layout with the chain preserved end to end", async () => {
    const root = join(dir, "migrate");
    const { auditRows, lastAuditHash } = await buildSplitLayout(root);

    const unified = openUnifiedDatabase(join(root, "nyx.db"));
    const db = unified.db;

    // Chain: old rows + exactly one db.migrated row, chained onto the old head.
    const count = db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
    expect(count.n).toBe(auditRows + 1);
    const migratedRow = db
      .prepare("SELECT prev_hash, action FROM audit ORDER BY id DESC LIMIT 1")
      .get() as { prev_hash: string; action: string };
    expect(migratedRow.action).toBe("db.migrated");
    expect(migratedRow.prev_hash).toBe(lastAuditHash); // chained onto the previous head
    expect(verifyAuditChain(db).ok).toBe(true);

    // Event log untouched (still in the same file), sessions intact.
    const sessions = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(1);

    // Engine approvals copied into policy_approvals.
    const appr = db
      .prepare("SELECT id, decision FROM policy_approvals WHERE id = 'appr_legacy_1'")
      .get() as { id: string; decision: string } | undefined;
    expect(appr).toEqual({ id: "appr_legacy_1", decision: "pending" });

    // The engine itself opens on the shared handle and sees the row.
    const sessionId = (db.prepare("SELECT id FROM sessions").get() as { id: string }).id;
    const engine = openApprovalEngine(db);
    const pending = await engine.engine.pending(sessionId);
    expect(pending.map((p) => p.id)).toContain("appr_legacy_1");
    engine.close();

    // Channel mapping + heartbeat state copied.
    const chan = db
      .prepare("SELECT session_id FROM channel_sessions WHERE channel = 'telegram'")
      .get() as { session_id: string };
    expect(chan.session_id).toBe("sess-chan-1");
    const hb = db
      .prepare(
        "SELECT last_fired_at, next_fire_at FROM heartbeat_state WHERE spec_id = 'memory-review'",
      )
      .get() as { last_fired_at: number; next_fire_at: number };
    expect(hb).toEqual({ last_fired_at: 1000, next_fire_at: 2000 });
    const hbHist = db.prepare("SELECT COUNT(*) AS n FROM heartbeat_history").get() as { n: number };
    expect(hbHist.n).toBe(1);

    // Legacy files renamed (never deleted), content still readable.
    expect(unified.migratedLegacyFiles.length).toBe(3);
    const names = await listDir(root);
    expect(names).toContain("nyx.db");
    expect(names).not.toContain("policy.db");
    expect(names).not.toContain("channels.db");
    expect(names).not.toContain("heartbeat.db");
    const renamedPolicy = unified.migratedLegacyFiles.find((p) => p.includes("policy.db"))!;
    expect(renamedPolicy).toMatch(/policy\.db\.migrated-\d+$/);
    const old = new Database(renamedPolicy);
    expect((old.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(
      auditRows,
    );
    old.close();
    unified.close();

    // Reopen: nothing left to migrate; the chain (incl. db.migrated) verifies.
    const again = openUnifiedDatabase(join(root, "nyx.db"));
    expect(again.migratedLegacyFiles).toEqual([]);
    expect(verifyAuditChain(again.db).ok).toBe(true);
    again.close();
  });

  it("aborts when the legacy chain does not verify and leaves originals intact", async () => {
    const root = join(dir, "abort");
    await buildSplitLayout(root);

    // Tamper with the legacy audit chain: edit a committed row's payload.
    const policyPath = join(root, "policy.db");
    const tamper = new Database(policyPath);
    tamper.exec("UPDATE audit SET payload_json = '{\"tampered\":true}' WHERE id = 2");
    tamper.close();

    expect(() => openUnifiedDatabase(join(root, "nyx.db"))).toThrow(/aborted/);

    // Originals intact: policy.db still at its path, still tampered (untouched
    // by us), and nyx.db gained no audit rows (the copy rolled back).
    expect(existsSync(policyPath)).toBe(true);
    const names = await listDir(root);
    expect(names.some((n) => /policy\.db\.migrated-/.test(n))).toBe(false);
    expect(names.some((n) => /channels\.db\.migrated-/.test(n))).toBe(false);
    expect(names.some((n) => /heartbeat\.db\.migrated-/.test(n))).toBe(false);
    const nyx = new Database(join(root, "nyx.db"));
    expect((nyx.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(0);
    const sessions = nyx.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
    expect(sessions.n).toBe(1); // pre-existing session data untouched
    nyx.close();
  });

  it("refuses to merge two non-empty audit chains", async () => {
    const root = join(dir, "conflict");
    await buildSplitLayout(root);
    // Put rows in BOTH files' audit tables — unmergeable.
    const nyx = new Database(join(root, "nyx.db"));
    appendAudit(nyx, { actor: "x", action: "unrelated", payload: {} });
    nyx.close();

    expect(() => openUnifiedDatabase(join(root, "nyx.db"))).toThrow(/cannot be merged/);
    expect(existsSync(join(root, "policy.db"))).toBe(true);
  });

  it("migrates a policy.db with no pre-existing nyx.db", async () => {
    const root = join(dir, "policy-only");
    mkdirSync(root, { recursive: true });
    const policyDb = new Database(join(root, "policy.db"));
    appendAudit(policyDb, { actor: "agent", action: "tool.call", payload: { x: 1 }, event_seq: 1 });
    policyDb.close();

    const unified = openUnifiedDatabase(join(root, "nyx.db"));
    expect((unified.db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(
      2,
    );
    expect(verifyAuditChain(unified.db).ok).toBe(true);
    unified.close();
  });
});
