// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { appendAudit, verifyAuditChain } from "./audit.js";

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

function entries(n: number): Array<{ actor: string; action: string; payload: unknown }> {
  return Array.from({ length: n }, (_, i) => ({
    actor: i % 2 === 0 ? "owner" : "agent",
    action: `test.event.${i}`,
    payload: { seq: i, note: `entry ${i}` },
  }));
}

describe("appendAudit", () => {
  it('creates the table on demand and chains from a genesis prev_hash of ""', () => {
    const db = freshDb();
    appendAudit(
      db,
      { actor: "owner", action: "genesis.test", payload: { a: 1 } },
      { now: () => 1000 },
    );
    const row = db.prepare("SELECT prev_hash, hash, payload_json, created_at FROM audit").get() as {
      prev_hash: string;
      hash: string;
      payload_json: string;
      created_at: number;
    };
    expect(row.prev_hash).toBe("");
    expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.payload_json).toBe('{"a":1}');
    expect(row.created_at).toBe(1000);
  });

  it("stores payloads in canonical form regardless of key order", () => {
    const db = freshDb();
    appendAudit(db, { actor: "a", action: "x", payload: { b: 2, a: 1 } });
    const row = db.prepare("SELECT payload_json FROM audit").get() as { payload_json: string };
    expect(row.payload_json).toBe('{"a":1,"b":2}');
  });
});

describe("verifyAuditChain", () => {
  it("verifies a clean chain of 5 entries", () => {
    const db = freshDb();
    let t = 0;
    for (const e of entries(5)) appendAudit(db, e, { now: () => (t += 10) });
    expect(verifyAuditChain(db)).toEqual({ ok: true, checked: 5 });
  });

  it("verifies an empty log as ok with checked 0", () => {
    const db = freshDb();
    expect(verifyAuditChain(db)).toEqual({ ok: true, checked: 0 });
  });

  it("detects a tampered payload_json", () => {
    const db = freshDb();
    for (const e of entries(5)) appendAudit(db, e);
    db.prepare("UPDATE audit SET payload_json = ? WHERE id = 2").run('{"seq":1,"note":"hacked"}');
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.first_bad_id).toBe(2);
    expect(result.checked).toBe(1);
  });

  it("detects a tampered created_at", () => {
    const db = freshDb();
    for (const e of entries(5)) appendAudit(db, e);
    db.prepare("UPDATE audit SET created_at = created_at + 1 WHERE id = 4").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.first_bad_id).toBe(4);
  });

  it("detects a tampered actor and a tampered action", () => {
    const db1 = freshDb();
    for (const e of entries(3)) appendAudit(db1, e);
    db1.prepare("UPDATE audit SET actor = 'mallory' WHERE id = 3").run();
    expect(verifyAuditChain(db1).first_bad_id).toBe(3);

    const db2 = freshDb();
    for (const e of entries(3)) appendAudit(db2, e);
    db2.prepare("UPDATE audit SET action = 'other.action' WHERE id = 1").run();
    expect(verifyAuditChain(db2).first_bad_id).toBe(1);
  });

  it("detects an edited-and-rehashed row via the next row's prev_hash link", () => {
    const db = freshDb();
    for (const e of entries(5)) appendAudit(db, e);
    // Attacker edits row 3's payload AND recomputes its own hash to stay
    // self-consistent; the link from row 4 still breaks.
    const row3 = db.prepare("SELECT * FROM audit WHERE id = 3").get() as {
      prev_hash: string;
      actor: string;
      action: string;
      payload_json: string;
      created_at: number;
    };
    const tampered = '{"seq":2,"note":"hacked"}';
    const hash = createHash("sha256")
      .update(
        `${row3.prev_hash}\n${tampered}\n${row3.actor}\n${row3.action}\n${String(row3.created_at)}`,
        "utf8",
      )
      .digest("hex");
    db.prepare("UPDATE audit SET payload_json = ?, hash = ? WHERE id = 3").run(tampered, hash);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    expect(result.first_bad_id).toBe(4);
  });

  it("deleting the LAST row keeps the chain valid (documented behavior)", () => {
    const db = freshDb();
    for (const e of entries(5)) appendAudit(db, e);
    db.prepare("DELETE FROM audit WHERE id = 5").run();
    expect(verifyAuditChain(db)).toEqual({ ok: true, checked: 4 });
  });

  it("deleting a MIDDLE row breaks the chain at the following row (documented behavior)", () => {
    const db = freshDb();
    for (const e of entries(5)) appendAudit(db, e);
    db.prepare("DELETE FROM audit WHERE id = 3").run();
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(false);
    // Row 4's prev_hash still points at (deleted) row 3's hash.
    expect(result.first_bad_id).toBe(4);
  });
});

describe("transaction participation", () => {
  it("appendAudit joins the caller's transaction: a throw rolls the audit row back", () => {
    const db = freshDb();
    appendAudit(db, { actor: "owner", action: "setup", payload: {} });
    const before = verifyAuditChain(db).checked;

    expect(() =>
      db.transaction(() => {
        appendAudit(db, { actor: "owner", action: "doomed", payload: { no: 1 } });
        throw new Error("boom");
      })(),
    ).toThrow("boom");

    expect(verifyAuditChain(db)).toEqual({ ok: true, checked: before });
    const actions = db.prepare("SELECT action FROM audit").all() as Array<{ action: string }>;
    expect(actions.some((a) => a.action === "doomed")).toBe(false);
  });

  it("appendAudit commits with the caller's transaction on success", () => {
    const db = freshDb();
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS side (x INTEGER)");
      db.prepare("INSERT INTO side (x) VALUES (?)").run(42);
      appendAudit(db, { actor: "owner", action: "side.write", payload: { x: 42 } });
    })();
    const actions = db.prepare("SELECT action FROM audit").all() as Array<{ action: string }>;
    expect(actions.some((a) => a.action === "side.write")).toBe(true);
    expect(verifyAuditChain(db).ok).toBe(true);
  });
});
