// SPDX-License-Identifier: AGPL-3.0-or-later
// 2.0.1 acceptance: event append and audit append share ONE transaction in the
// unified database. A crash (or abort) between the two statements leaves
// NEITHER row; concurrent appends produce a complete, verifiable chain.
//
// RED stage: `onEventsCommitted` does not exist on SessionStoreOptions yet —
// the option is silently ignored, so events commit without their audit rows
// and nothing can roll back. Every assertion below that depends on the seam
// fails until the green commit lands.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openSessionStore } from "@nyx/session";
import {
  appendEventAudit,
  ensureAuditTable,
  reconcileEventAudit,
  verifyAuditChain,
} from "@nyx/policy";
import type { SessionEvent } from "@nyx/protocol";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nyx-db-atomicity-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A tool.call event payload for session `sid`, call index `i`. */
function toolCall(sid: string, i: number): SessionEvent {
  return {
    type: "tool.call",
    session_id: sid,
    turn_id: "turn-1",
    call_id: `call-${i}`,
    name: "fs.read",
    input: { path: `/tmp/f-${i}.txt` },
    ts: 1_700_000_000_000 + i,
  };
}

describe("2.0.1 unified database transactionality", () => {
  it("commits event and audit row together (happy path)", async () => {
    const dbPath = join(dir, "happy.db");
    const db = new Database(dbPath);
    const store = openSessionStore(dbPath, {
      db,
      onEventsCommitted: (stored) => {
        for (const ev of stored) appendEventAudit(db, ev, ev.seq);
      },
    });
    const meta = await store.create({ owner_id: "owner", persona_id: "default" });
    await store.append(meta.session_id, [toolCall(meta.session_id, 0)]);
    store.close();

    const check = new Database(dbPath);
    const events = check
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool.call'")
      .get() as { n: number };
    const audit = check
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE event_seq IS NOT NULL")
      .get() as { n: number };
    expect(events.n).toBe(1);
    expect(audit.n).toBe(1); // RED: no seam → no audit row
    expect(verifyAuditChain(check).ok).toBe(true);
    check.close();
  });

  it("aborts before commit → neither event nor audit row exists", async () => {
    const dbPath = join(dir, "abort.db");
    const db = new Database(dbPath);
    // Crash between the event INSERT and the audit INSERT: the hook throws
    // before appending the audit row, the transaction rolls back.
    const store = openSessionStore(dbPath, {
      db,
      onEventsCommitted: (stored) => {
        if (stored.some((ev) => ev.type === "tool.call")) {
          throw new Error("simulated crash between event insert and audit append");
        }
      },
    });
    const meta = await store.create({ owner_id: "owner", persona_id: "default" });
    await expect(store.append(meta.session_id, [toolCall(meta.session_id, 1)])).rejects.toThrow(
      /simulated crash/,
    );
    store.close();

    const check = new Database(dbPath);
    // Any real opener (engine / unified-db) ensures the audit table shape;
    // the rollback also rolled back the ALTER TABLE that would have added it.
    ensureAuditTable(check);
    const events = check
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool.call'")
      .get() as { n: number };
    const audit = check
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE event_seq IS NOT NULL")
      .get() as { n: number };
    expect(events.n).toBe(0); // RED: the event commits — no rollback seam
    expect(audit.n).toBe(0);
    check.close();
  });

  it("rolls back both rows when the failure lands AFTER the audit append", async () => {
    const dbPath = join(dir, "rollback.db");
    const db = new Database(dbPath);
    let appended = false;
    const store = openSessionStore(dbPath, {
      db,
      onEventsCommitted: (stored) => {
        for (const ev of stored) appendEventAudit(db, ev, ev.seq);
        if (stored.some((ev) => ev.type === "tool.call")) {
          appended = true;
          throw new Error("simulated crash after audit append, before commit");
        }
      },
    });
    const meta = await store.create({ owner_id: "owner", persona_id: "default" });
    await expect(store.append(meta.session_id, [toolCall(meta.session_id, 2)])).rejects.toThrow(
      /before commit/,
    );
    expect(appended).toBe(true);
    store.close();

    const check = new Database(dbPath);
    // The rollback also rolled back the ALTER TABLE (DDL is transactional).
    ensureAuditTable(check);
    const events = check
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool.call'")
      .get() as { n: number };
    const audit = check
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE event_seq IS NOT NULL")
      .get() as { n: number };
    expect(events.n).toBe(0); // both writes rolled back with the transaction
    expect(audit.n).toBe(0);
    check.close();
  });

  it("survives a process death mid-transaction (db closed, no commit)", () => {
    const dbPath = join(dir, "crash.db");
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    // Open a deferred transaction, write, then close WITHOUT committing —
    // the shape of a process dying between two statements.
    db.exec("BEGIN");
    db.prepare("INSERT INTO t (v) VALUES ('doomed')").run();
    db.close();

    const check = new Database(dbPath);
    const rows = check.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    expect(rows.n).toBe(0); // the uncommitted write never landed
    check.close();
  });

  it("concurrently appends 100 tool events from 4 workers → 200 rows, chain verifies", async () => {
    const dbPath = join(dir, "concurrent.db");
    const db = new Database(dbPath);
    const store = openSessionStore(dbPath, {
      db,
      onEventsCommitted: (stored) => {
        for (const ev of stored) appendEventAudit(db, ev, ev.seq);
      },
    });
    const meta = await store.create({ owner_id: "owner", persona_id: "default" });
    const sid = meta.session_id;

    const WORKERS = 4;
    const PER_WORKER = 25;
    const worker = async (workerId: number): Promise<void> => {
      for (let i = 0; i < PER_WORKER; i++) {
        await store.append(sid, [toolCall(sid, workerId * PER_WORKER + i)]);
      }
    };
    await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)));
    store.close();

    const check = new Database(dbPath);
    const events = check
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'tool.call'")
      .get() as { n: number };
    const audit = check
      .prepare("SELECT COUNT(*) AS n FROM audit WHERE event_seq IS NOT NULL")
      .get() as { n: number };
    expect(events.n).toBe(WORKERS * PER_WORKER);
    expect(audit.n).toBe(WORKERS * PER_WORKER); // RED: no seam → 0 audit rows

    const verification = verifyAuditChain(check);
    expect(verification.ok).toBe(true);
    expect(verification.checked).toBeGreaterThanOrEqual(WORKERS * PER_WORKER);

    const stored = (
      check.prepare("SELECT seq, payload_json FROM events ORDER BY seq").all() as Array<{
        seq: number;
        payload_json: string;
      }>
    ).map((row) => ({
      ...(JSON.parse(row.payload_json) as SessionEvent),
      seq: row.seq,
    }));
    expect(reconcileEventAudit(check, stored)).toEqual([]);
    check.close();
  });
});
