// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { ApprovalEngineImpl, openApprovalEngine } from "./approvals.js";
import { verifyAuditChain } from "./audit.js";
import type { ApprovalRecord, PolicyVerdict } from "@nyx/protocol";

type DB = Database.Database;

const dbs: DB[] = [];

function freshDb(): DB {
  const db = new Database(":memory:");
  dbs.push(db);
  return db;
}

afterAll(() => {
  for (const db of dbs) db.close();
});

function verdict(overrides: Partial<PolicyVerdict> = {}): PolicyVerdict {
  return {
    decision: "ask",
    rule_id: "invariant:dangerous-capability",
    action_digest: "d-" + Math.random().toString(36).slice(2, 10),
    summary: '"git.push" on {"host":"example.com"} [risk R3]',
    ...overrides,
  };
}

const CTX = { session_id: "s1", turn_id: "t1", actor_id: "agent" };

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until cond() is true (or fail the test after `ms`). */
async function until(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await sleep(2);
  }
  throw new Error("condition not met in time");
}

describe("ApprovalEngineImpl", () => {
  it("creates its tables on any db handle (including a fresh one)", () => {
    const db = freshDb();
    new ApprovalEngineImpl(db, { now: () => 0 });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('approvals','audit')")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual(["approvals", "audit"]);
  });

  it("request → pending visible → resolve allow → promise resolves allow", async () => {
    const db = freshDb();
    const t = 1000;
    const engine = new ApprovalEngineImpl(db, { now: () => t, ttl_ms: 60_000, poll_ms: 2 });
    const v = verdict();

    const p = engine.request(v, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);

    const pending = await engine.pending("s1");
    const rec = pending[0] as ApprovalRecord;
    expect(rec.decision).toBe("pending");
    expect(rec.decided_by).toBeNull();
    expect(rec.used_at).toBeNull();
    expect(rec.action_digest).toBe(v.action_digest);
    expect(rec.summary).toBe(v.summary);
    expect(rec.risk).toBe("R3");
    expect(rec.session_id).toBe("s1");
    expect(rec.turn_id).toBe("t1");
    expect(rec.expires_at).toBe(1000 + 60_000);

    const resolved = await engine.resolve(rec.id, "allow", "owner");
    expect(resolved.decision).toBe("allow");
    expect(resolved.decided_by).toBe("owner");

    await expect(p).resolves.toBe("allow");
    expect((await engine.get(rec.id))?.decision).toBe("allow");
    expect(await engine.pending("s1")).toHaveLength(0);
  });

  it("resolve deny ends the request with deny", async () => {
    const db = freshDb();
    const engine = new ApprovalEngineImpl(db, { now: () => 2000, ttl_ms: 60_000, poll_ms: 2 });
    const p = engine.request(verdict(), CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await engine.resolve(rec!.id, "deny", "owner");
    await expect(p).resolves.toBe("deny");
  });

  it("expiry auto-denies (system:expiry) and empties the pending list", async () => {
    const db = freshDb();
    let t = 0;
    const engine = new ApprovalEngineImpl(db, { now: () => t, ttl_ms: 100, poll_ms: 2 });
    const v = verdict();
    const p = engine.request(v, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");

    t = 100; // now >= expires_at
    await expect(p).resolves.toBe("deny");

    const after = await engine.get(rec!.id);
    expect(after?.decision).toBe("deny");
    expect(after?.decided_by).toBe("system:expiry");
    expect(await engine.pending("s1")).toHaveLength(0);

    const actions = db.prepare("SELECT action FROM audit").all() as Array<{ action: string }>;
    expect(actions.some((a) => a.action === "approval.expired")).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("writes approval.requested audit rows bound to the action digest", async () => {
    const db = freshDb();
    const engine = new ApprovalEngineImpl(db, { now: () => 3000, ttl_ms: 60_000, poll_ms: 2 });
    const v = verdict();
    const p = engine.request(v, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await engine.resolve(rec!.id, "deny", "owner");
    await p;

    const row = db.prepare("SELECT actor, payload_json FROM audit WHERE action = 'approval.requested'").get() as {
      actor: string;
      payload_json: string;
    };
    expect(row.actor).toBe("agent");
    expect(row.payload_json).toContain(v.action_digest);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("consume marks the approval used; reuse and digest mismatch throw typed errors", async () => {
    const db = freshDb();
    const t = 5000;
    const engine = new ApprovalEngineImpl(db, { now: () => t, ttl_ms: 60_000, poll_ms: 2 });
    const v = verdict();
    const p = engine.request(v, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await engine.resolve(rec!.id, "allow", "owner");
    await expect(p).resolves.toBe("allow");

    const consumed = await engine.consume(rec!.id, v.action_digest);
    expect(consumed.used_at).toBe(5000);
    expect((await engine.get(rec!.id))?.used_at).toBe(5000);

    // Single-use: consuming the same id again throws.
    await expect(engine.consume(rec!.id, v.action_digest)).rejects.toMatchObject({
      code: "approval_denied",
      message: expect.stringContaining("already consumed"),
    });

    // Exact-action binding: a fresh approval consumed with the wrong digest throws.
    const v2 = verdict();
    const p2 = engine.request(v2, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec2] = await engine.pending("s1");
    await engine.resolve(rec2!.id, "allow", "owner");
    await expect(p2).resolves.toBe("allow");
    await expect(engine.consume(rec2!.id, "not-the-digest")).rejects.toMatchObject({
      code: "approval_denied",
      message: "digest mismatch",
    });
  });

  it("consume on a pending or denied approval throws", async () => {
    const db = freshDb();
    const engine = new ApprovalEngineImpl(db, { now: () => 7000, ttl_ms: 60_000, poll_ms: 2 });
    const p = engine.request(verdict(), CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await expect(engine.consume(rec!.id, rec!.action_digest)).rejects.toMatchObject({
      code: "approval_denied",
    });
    await engine.resolve(rec!.id, "deny", "owner");
    await expect(p).resolves.toBe("deny");
    await expect(engine.consume(rec!.id, rec!.action_digest)).rejects.toMatchObject({
      code: "approval_denied",
    });
    await expect(engine.consume("missing-id", "x")).rejects.toMatchObject({ code: "approval_denied" });
  });

  it("resolve throws on double resolution", async () => {
    const db = freshDb();
    const engine = new ApprovalEngineImpl(db, { now: () => 8000, ttl_ms: 60_000, poll_ms: 2 });
    const p = engine.request(verdict(), CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await engine.resolve(rec!.id, "allow", "owner");
    await expect(engine.resolve(rec!.id, "deny", "owner")).rejects.toMatchObject({
      code: "approval_denied",
      message: expect.stringContaining("already resolved"),
    });
    await p;
  });

  it("resolve after expiry throws approval_expired and writes no resolution audit row (transactional guarantee)", async () => {
    const db = freshDb();
    let t = 10_000;
    const engine = new ApprovalEngineImpl(db, { now: () => t, ttl_ms: 100, poll_ms: 1000 });
    const p = engine.request(verdict(), CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");

    // Advance past expiry, then call resolve while the request loop is still
    // asleep: resolve must throw inside its transaction, so its audit row
    // (which would have been written in the same block) is rolled back.
    t = 10_101;
    await expect(engine.resolve(rec!.id, "allow", "owner")).rejects.toMatchObject({
      code: "approval_expired",
    });
    const actions = db.prepare("SELECT action FROM audit").all() as Array<{ action: string }>;
    expect(actions.filter((a) => a.action === "approval.resolved")).toHaveLength(0);

    // The request loop then wakes up, auto-denies, and the audit chain is intact.
    await expect(p).resolves.toBe("deny");
    const finalActions = db.prepare("SELECT action FROM audit").all() as Array<{ action: string }>;
    expect(finalActions.filter((a) => a.action === "approval.resolved")).toHaveLength(0);
    expect(finalActions.some((a) => a.action === "approval.expired")).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);
  });

  it("pending() lists only pending+unexpired, newest first", async () => {
    const db = freshDb();
    let t = 20_000;
    const engine = new ApprovalEngineImpl(db, { now: () => t, ttl_ms: 1000, poll_ms: 50 });

    const v1 = verdict();
    const p1 = engine.request(v1, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    t = 20_100; // distinct created_at for the second request
    const v2 = verdict();
    const p2 = engine.request(v2, { ...CTX, session_id: "s1" });
    await until(async () => (await engine.pending("s1")).length === 2);
    t = 20_200; // distinct created_at for the third request
    const v3 = verdict();
    const p3 = engine.request(v3, { ...CTX, session_id: "s2" });
    await until(async () => (await engine.pending("s2")).length === 1);

    const pendingS1 = await engine.pending("s1");
    expect(pendingS1.map((r) => r.action_digest)).toEqual([v2.action_digest, v1.action_digest]);
    expect(await engine.pending("s2")).toHaveLength(1);

    // Expired approvals drop out of the pending list.
    t = 21_200; // v1 (expires 21_000) and v2 (expires 21_100) are both expired
    const pendingAfter = await engine.pending("s1");
    expect(pendingAfter.map((r) => r.action_digest)).toEqual([]);

    await Promise.all([p1, p2, p3]).then((results) => {
      expect(results).toEqual(["deny", "deny", "deny"]);
    });
  });

  it("onCreated fires with the pending record; onResolved fires on resolve", async () => {
    const db = freshDb();
    const created: ApprovalRecord[] = [];
    const resolved: ApprovalRecord[] = [];
    const engine = new ApprovalEngineImpl(db, {
      now: () => 5000,
      ttl_ms: 60_000,
      poll_ms: 2,
      onCreated: (r) => created.push(r),
      onResolved: (r) => resolved.push(r),
    });
    const v = verdict();
    const p = engine.request(v, CTX);
    await until(() => created.length === 1);

    expect(created[0]!.decision).toBe("pending");
    expect(created[0]!.action_digest).toBe(v.action_digest);
    expect(created[0]!.risk).toBe("R3");
    expect(created[0]!.expires_at).toBe(5000 + 60_000);
    expect(resolved).toHaveLength(0);

    await engine.resolve(created[0]!.id, "allow", "owner");
    await p;
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.decision).toBe("allow");
    expect(resolved[0]!.decided_by).toBe("owner");
  });

  it("onResolved fires on expiry auto-deny with decided_by system:expiry", async () => {
    const db = freshDb();
    let t = 0;
    const resolved: ApprovalRecord[] = [];
    const engine = new ApprovalEngineImpl(db, {
      now: () => t,
      ttl_ms: 100,
      poll_ms: 2,
      onResolved: (r) => resolved.push(r),
    });
    const p = engine.request(verdict(), CTX);
    await until(async () => (await engine.pending("s1")).length === 1);

    t = 100;
    await expect(p).resolves.toBe("deny");

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.decision).toBe("deny");
    expect(resolved[0]!.decided_by).toBe("system:expiry");
  });

  it("openApprovalEngine opens a file-backed engine and close() shuts it down", async () => {
    const dir = await mkdtemp(tmpdir() + "/nyx-approval-");
    const path = dir + "/policy.db";
    const { engine, close } = openApprovalEngine(path, { now: () => 9000, ttl_ms: 60_000, poll_ms: 2 });
    const v = verdict();
    const p = engine.request(v, CTX);
    await until(async () => (await engine.pending("s1")).length === 1);
    const [rec] = await engine.pending("s1");
    await engine.resolve(rec!.id, "deny", "owner");
    await p;
    close();
    // Reopening the same file sees the resolved record (durability).
    const reopened = openApprovalEngine(path);
    const stored = await reopened.engine.get(rec!.id);
    expect(stored?.decision).toBe("deny");
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  });
});
