// SPDX-License-Identifier: AGPL-3.0-or-later
// Acceptance tests for tool events in the hash-chained audit log
// (Phase 1 hardening 2.2): every tool.call / tool.result / tool.error /
// action.denied event lands as exactly one audit row carrying the event seq;
// tampering with such a row breaks chain verification; 1,000 interleaved
// approval + tool events verify end to end.
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { canonicalJson } from "@nyx/protocol";
import { appendEventAudit, reconcileEventAudit } from "./event-audit.js";
import { appendAudit, ensureAuditTable, verifyAuditChain } from "./audit.js";
import { ApprovalEngineImpl } from "./approvals.js";
import type { SessionEvent } from "@nyx/protocol";

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

const SID = "sess-audit";
const TID = "turn-audit";

function toolCall(seq: number, callId: string, name: string): SessionEvent & { seq: number } {
  return {
    type: "tool.call",
    session_id: SID,
    turn_id: TID,
    call_id: callId,
    name,
    input: { path: "/tmp/x" },
    ts: 1_000 + seq,
    seq,
  };
}

function toolResult(seq: number, callId: string): SessionEvent & { seq: number } {
  return {
    type: "tool.result",
    session_id: SID,
    turn_id: TID,
    call_id: callId,
    output: { kind: "text", text: "ok" },
    ts: 1_000 + seq,
    seq,
  };
}

function toolError(seq: number, callId: string): SessionEvent & { seq: number } {
  return {
    type: "tool.error",
    session_id: SID,
    turn_id: TID,
    call_id: callId,
    error: { name: "ToolError", message: "boom" },
    ts: 1_000 + seq,
    seq,
  };
}

function actionDenied(seq: number, callId: string): SessionEvent & { seq: number } {
  return {
    type: "action.denied",
    session_id: SID,
    turn_id: TID,
    call_id: callId,
    reason: "scope",
    detail: "denied by scope: host evil.example not in engagement scope",
    ts: 1_000 + seq,
    seq,
  };
}

function lifecycleEvent(seq: number): SessionEvent & { seq: number } {
  return {
    type: "turn.completed",
    session_id: SID,
    turn_id: TID,
    usage: { input_tokens: 1, output_tokens: 1 },
    ts: 1_000 + seq,
    seq,
  };
}

describe("tool events in the hash-chained audit log", () => {
  it("every tool.call / tool.result / tool.error / action.denied event has exactly one audit row with a matching action and event_seq", () => {
    const db = freshDb();
    ensureAuditTable(db);
    const events = [
      toolCall(2, "c1", "fs.read"),
      toolResult(3, "c1"),
      toolCall(4, "c2", "web.fetch"),
      toolError(5, "c2"),
      actionDenied(6, "c3"),
      lifecycleEvent(7), // not audited
      lifecycleEvent(8), // not audited
    ];
    for (const e of events) appendEventAudit(db, e, e.seq);

    const rows = db
      .prepare("SELECT id, action, event_seq, actor FROM audit ORDER BY id")
      .all() as Array<{ id: number; action: string; event_seq: number | null; actor: string }>;
    expect(rows.map((r) => [r.action, r.event_seq])).toEqual([
      ["tool.call", 2],
      ["tool.result", 3],
      ["tool.call", 4],
      ["tool.error", 5],
      ["action.denied", 6],
    ]);
    expect(rows.every((r) => r.actor === "agent" || r.actor === "system:runtime")).toBe(true);
    // Lifecycle events produced no rows.
    expect(rows.filter((r) => r.event_seq === 7 || r.event_seq === 8)).toEqual([]);

    // Cross-check: clean reconciliation, and the chain verifies.
    expect(reconcileEventAudit(db, events)).toEqual([]);
    expect(verifyAuditChain(db).ok).toBe(true);

    // A missing row is reported (simulate a crash between append and audit).
    const db2 = freshDb();
    ensureAuditTable(db2);
    for (const e of events.slice(0, 4)) appendEventAudit(db2, e, e.seq); // drop the denial
    const problems = reconcileEventAudit(db2, events);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("action.denied");
    expect(problems[0]).toContain("seq 6");
  });

  it("tampering with a tool.result audit row breaks the chain on verification", () => {
    const db = freshDb();
    ensureAuditTable(db);
    appendEventAudit(db, toolCall(2, "c1", "fs.read"), 2);
    appendEventAudit(db, toolResult(3, "c1"), 3);
    appendEventAudit(db, toolCall(4, "c2", "shell.exec"), 4);
    expect(verifyAuditChain(db).ok).toBe(true);

    // Out-of-band edit of the tool.result row's payload.
    db.prepare("UPDATE audit SET payload_json = ? WHERE event_seq = 3").run(
      canonicalJson({ session_id: SID, call_id: "c1", output: { kind: "text", text: "TAMPERED" } }),
    );
    const verdict = verifyAuditChain(db);
    expect(verdict.ok).toBe(false);
    expect(verdict.first_bad_id).toBeDefined();

    // The event_seq link itself is hash-covered: relinking a row to a
    // different event also breaks verification.
    const db2 = freshDb();
    ensureAuditTable(db2);
    appendEventAudit(db2, toolResult(3, "c1"), 3);
    db2.prepare("UPDATE audit SET event_seq = 99 WHERE event_seq = 3").run();
    expect(verifyAuditChain(db2).ok).toBe(false);
  });

  it("the chain verifies end to end with 1,000 interleaved approval + tool events", async () => {
    const db = freshDb();
    ensureAuditTable(db);
    let clock = 5_000_000;
    const engine = new ApprovalEngineImpl(db, { now: () => clock, poll_ms: 1, ttl_ms: 600_000 });
    const CTX = { session_id: SID, turn_id: TID, actor_id: "agent" };

    const events: Array<SessionEvent & { seq: number }> = [];
    let seq = 1;
    let callN = 0;
    for (let i = 0; i < 250; i++) {
      // One approval decision pair (requested via the engine, resolved allow).
      const verdict = {
        decision: "ask" as const,
        rule_id: "invariant:dangerous-capability",
        action_digest: `sha256:d-${i}`,
        summary: `"shell.exec" on {"n":${i}} [risk R3]`,
      };
      const pending = engine.request(verdict, CTX);
      for (let spin = 0; spin < 200; spin++) {
        const row = db
          .prepare("SELECT id FROM approvals WHERE action_digest = ? AND decision = 'pending'")
          .get(verdict.action_digest) as { id: string } | undefined;
        if (row !== undefined) break;
        await new Promise((r) => setTimeout(r, 1));
      }
      const row = db
        .prepare("SELECT id FROM approvals WHERE action_digest = ? AND decision = 'pending'")
        .get(verdict.action_digest) as { id: string };
      await engine.resolve(row.id, "allow", "owner");
      await expect(pending).resolves.toBe("allow");

      // Four tool events around it, all audited with their seq.
      callN += 1;
      const callId = `call-${callN}`;
      const batch = [
        toolCall(seq++, callId, "fs.read"),
        toolResult(seq++, callId),
      ];
      callN += 1;
      const callId2 = `call-${callN}`;
      batch.push(toolCall(seq++, callId2, "web.fetch"), actionDenied(seq++, callId2));
      for (const e of batch) {
        appendEventAudit(db, e, e.seq);
        events.push(e);
      }
      clock += 3;
    }

    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(250 * 6); // 2 approval rows + 4 tool rows per iteration
    expect(reconcileEventAudit(db, events)).toEqual([]);

    // And the chain really is load-bearing: flip one byte in the middle.
    const mid = db
      .prepare("SELECT id FROM audit WHERE event_seq IS NOT NULL ORDER BY id LIMIT 1 OFFSET 500")
      .get() as { id: number };
    db.prepare("UPDATE audit SET actor = 'attacker' WHERE id = ?").run(mid.id);
    expect(verifyAuditChain(db).ok).toBe(false);
  });

  it("migrates a pre-event_seq audit table in place and keeps verifying legacy rows", () => {
    // A database from before this change: audit table without event_seq.
    const db = freshDb();
    db.exec(
      `CREATE TABLE audit (
         id INTEGER PRIMARY KEY AUTOINCREMENT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
         actor TEXT NOT NULL, action TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
       )`,
    );
    // One legacy row, hashed over the exact legacy material.
    const payloadJson = canonicalJson({ approval_id: "legacy", decision: "allow" });
    const legacyHash = createHash("sha256")
      .update(`\n${payloadJson}\nowner\napproval.resolved\n1000000`, "utf8")
      .digest("hex");
    db.prepare(
      "INSERT INTO audit (prev_hash, hash, actor, action, payload_json, created_at) VALUES ('', ?, 'owner', 'approval.resolved', ?, 1000000)",
    ).run(legacyHash, payloadJson);

    // Opening the audit surface migrates the table…
    ensureAuditTable(db);
    const cols = db.pragma("table_info(audit)") as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "event_seq")).toBe(true);
    // …the legacy row still verifies…
    expect(verifyAuditChain(db).ok).toBe(true);
    // …and new event-audited rows chain onto it.
    appendEventAudit(db, toolCall(9, "c9", "fs.read"), 9);
    const result = verifyAuditChain(db);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    const row = db
      .prepare("SELECT event_seq FROM audit WHERE action = 'tool.call'")
      .get() as { event_seq: number };
    expect(row.event_seq).toBe(9);
  });
});

// Append-audit rows must survive the reconciliation view even when the caller
// passes plain StoredEvent shapes (the sink passes the store's return value).
describe("appendEventAudit no-ops and payload shapes", () => {
  it("non-auditable events write nothing", () => {
    const db = freshDb();
    ensureAuditTable(db);
    appendEventAudit(db, lifecycleEvent(1), 1);
    appendEventAudit(
      db,
      { type: "session.created", session_id: SID, owner_id: "o", persona_id: "p", parent_id: null, engagement: null, ts: 1 },
      1,
    );
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number }).n).toBe(0);
    expect(reconcileEventAudit(db, [lifecycleEvent(1)])).toEqual([]);
  });
});
