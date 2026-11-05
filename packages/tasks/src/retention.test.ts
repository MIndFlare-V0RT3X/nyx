// SPDX-License-Identifier: AGPL-3.0-or-later
// Retention acceptance (Phase 4 §3.2): archiving MOVES event rows to the
// archive database and marks the session (never deletes), read() serves
// archived sessions from the archive, appends are refused, live/failed task
// ties are protected per scope, the deletion pass only ever touches
// archived sessions, audit rows land on the hash chain, and the whole thing
// is wired as the `nyx:retention-gc` durable task — created by the surface,
// not swept at startup.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openSessionStore } from "@nyx/session";
import { verifyAuditChain } from "@nyx/policy";
import type { SessionStore, TaskRecord } from "@nyx/protocol";
import {
  createTaskManager,
  ensureRetentionTask,
  retentionTaskSpec,
  runRetention,
  runRetentionAttempt,
  RETENTION_TASK_ID,
  type TaskManager,
} from "./index.js";

const T0 = Date.UTC(2026, 4, 1, 0, 0, 0); // 2026-05-01 — fixed "now" for windows
const DAY = 86_400_000;
const OWNER = { owner_id: "test-owner", persona_id: "test-persona" };

interface Stack {
  db: Database.Database;
  store: SessionStore;
  manager: TaskManager;
  close(): void;
}

const stacks: Stack[] = [];

function makeStack(archivePath = ":memory:"): Stack {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const store = openSessionStore(":memory:", { db, archivePath });
  const manager = createTaskManager({ db, store, now: () => T0 });
  const stack: Stack = {
    db,
    store,
    manager,
    close: () => {
      store.close();
      db.close();
    },
  };
  stacks.push(stack);
  return stack;
}

/** A subagent-kind session with a small event log, aged `days` into the past. */
async function agedSubagent(
  s: Stack,
  days: number,
  opts: { kind?: "session" | "subagent" | "fork"; title?: string } = {},
): Promise<string> {
  const meta = await s.store.create({
    owner_id: OWNER.owner_id,
    persona_id: OWNER.persona_id,
    title: opts.title ?? "old child",
    kind: opts.kind ?? "subagent",
  });
  await s.store.append(meta.session_id, [
    {
      type: "subagent.completed",
      session_id: meta.session_id,
      subagent_session_id: meta.session_id,
      parent_session_id: "none",
      summary: "did things",
      tokens_used: 100,
      duration_ms: 5_000,
      ts: T0 - days * DAY,
    },
    {
      type: "subagent.aborted",
      session_id: meta.session_id,
      subagent_session_id: meta.session_id,
      parent_session_id: "none",
      reason: "test fixture",
      ts: T0 - days * DAY + 1,
    },
  ]);
  s.db
    .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
    .run(T0 - days * DAY, meta.session_id);
  return meta.session_id;
}

/** A task parked in `state`, tied to `tie` (its own session / its child / its parent). */
async function taskIn(
  s: Stack,
  state: "pending" | "running" | "paused" | "failed" | "completed",
  tie: { child_session_id?: string; parent_session_id?: string } = {},
): Promise<TaskRecord> {
  const rec = await s.manager.create(
    {
      title: `task ${state}`,
      description: "x",
      ...(tie.parent_session_id !== undefined ? { parent_session_id: tie.parent_session_id } : {}),
      subagent_spec: {},
      max_attempts: 3,
      retry_backoff_ms: 1000,
      priority: "background",
    } as never,
    OWNER,
  );
  if (state === "pending") return rec;
  s.manager.sql.claim(rec.id, "w", 300_000, T0);
  if (tie.child_session_id !== undefined) {
    s.manager.sql.setSubagentSession(rec.id, tie.child_session_id, "w");
  }
  if (state === "running") return (await s.manager.get(rec.id))!;
  if (state === "paused") {
    await s.manager.pause(rec.id);
    return (await s.manager.get(rec.id))!;
  }
  s.manager.sql.settleRunning(rec.id, "w", state, {
    attempts: 1,
    ...(state === "failed" ? { last_error: { name: "Error", message: "x" } } : {}),
  });
  return (await s.manager.get(rec.id))!;
}

const CFG = (over: Partial<Parameters<typeof runRetention>[0]["config"]> = {}) => ({
  retention_days: 7,
  retention_scope: "subagent" as const,
  delete_after_days: 0,
  ...over,
});

afterAll(async () => {
  while (stacks.length > 0) stacks.pop()!.close();
});

describe("archiving (§3.2)", () => {
  it("moves an old subagent session's events to the archive and marks it — never deletes", async () => {
    const s = makeStack();
    const sid = await agedSubagent(s, 10);

    const stats = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG(),
      now: () => T0,
    });
    expect(stats).toMatchObject({
      scanned: 1,
      archived_sessions: 1,
      archived_events: 3, // session.created + the two fixture events
      deleted_sessions: 0,
    });

    // The sessions row STAYS (resolvable, meta intact) and is marked.
    const meta = await s.store.meta(sid);
    expect(meta).not.toBeNull();
    expect(meta!.archived_at).toBe(T0);
    const row = s.db
      .prepare("SELECT archived, archived_at FROM sessions WHERE id = ?")
      .get(sid) as {
      archived: number;
      archived_at: number;
    };
    expect(row.archived).toBe(1);
    expect(row.archived_at).toBe(T0);

    // Main nyx.db no longer carries the events; the archive does, byte-identical.
    const mainCount = s.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
      .get(sid) as { n: number };
    expect(mainCount.n).toBe(0);
    const archiveRows = s.db
      .prepare(
        "SELECT seq, session_id, type, payload_json, ts FROM archive.events WHERE session_id = ? ORDER BY seq",
      )
      .all(sid) as Array<{ seq: number; session_id: string; type: string; ts: number }>;
    expect(archiveRows).toHaveLength(3);
    expect(archiveRows[0]!.type).toBe("session.created");
    // seqs are the GLOBAL ones preserved — ordering survives the move.
    expect(archiveRows[1]!.seq).toBeGreaterThan(archiveRows[0]!.seq);

    // list() hides it by default, shows it with include_archived.
    expect((await s.store.list({})).find((m) => m.session_id === sid)).toBeUndefined();
    expect(
      (await s.store.list({ include_archived: true })).find((m) => m.session_id === sid),
    ).toBeDefined();

    // read() serves the full log from the archive — same shape as before.
    const events = await s.store.read(sid);
    expect(events.map((e) => e.type)).toEqual([
      "session.created",
      "subagent.completed",
      "subagent.aborted",
    ]);
    expect(events.every((e) => e.session_id === sid)).toBe(true);

    // Appends are refused: the log must never split across databases.
    await expect(
      s.store.append(sid, [
        {
          type: "subagent.aborted",
          session_id: sid,
          subagent_session_id: sid,
          parent_session_id: "none",
          reason: "late",
          ts: T0,
        },
      ]),
    ).rejects.toMatchObject({ code: "archived" });
    await expect(s.store.fork(sid, 1)).rejects.toMatchObject({ code: "archived" });
  });

  it("keeps sessions inside the window and non-subagent kinds (scope=subagent)", async () => {
    const s = makeStack();
    const fresh = await agedSubagent(s, 2); // inside the 7-day window
    const primary = await agedSubagent(s, 30, { kind: "session" }); // wrong kind
    const fork = await agedSubagent(s, 30, { kind: "fork" }); // wrong kind

    const stats = runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });
    expect(stats).toMatchObject({ scanned: 0, archived_sessions: 0 });
    for (const sid of [fresh, primary, fork]) {
      expect((await s.store.read(sid)).length).toBeGreaterThan(0);
      expect(
        (
          s.db.prepare("SELECT archived FROM sessions WHERE id = ?").get(sid) as {
            archived: number;
          }
        ).archived,
      ).toBe(0);
    }
  });

  it("scope=none and retention_days=0 are no-ops", async () => {
    const s = makeStack();
    await agedSubagent(s, 30);
    await agedSubagent(s, 30);
    const a = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ retention_scope: "none" }),
      now: () => T0,
    });
    const b = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ retention_days: 0 }),
      now: () => T0,
    });
    expect(a.archived_sessions).toBe(0);
    expect(b.archived_sessions).toBe(0);
    expect(
      (s.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
    ).toBeGreaterThan(0);
  });

  it("re-running is idempotent (archived rows leave the candidate set)", async () => {
    const s = makeStack();
    await agedSubagent(s, 10);
    const first = runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });
    const second = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG(),
      now: () => T0,
    });
    expect(first.archived_sessions).toBe(1);
    expect(second).toMatchObject({ scanned: 0, archived_sessions: 0 });
    // No duplicated archive rows either.
    expect(
      (s.db.prepare("SELECT COUNT(*) AS n FROM archive.events").get() as { n: number }).n,
    ).toBe(3);
  });
});

describe("live-work protection (§3.2)", () => {
  it("never archives sessions tied to pending/running/paused tasks (own, child, parent ties)", async () => {
    const s = makeStack();
    // Park a task whose own session is old: create then age its session row.
    const running = await taskIn(s, "running", { child_session_id: await agedSubagent(s, 30) });
    s.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(T0 - 30 * DAY, running.task_session_id);
    const boundParent = await agedSubagent(s, 30, { kind: "session" });
    await taskIn(s, "pending", { parent_session_id: boundParent });
    // The task.created mirror touched the parent with the REAL clock —
    // re-age it so the window sees it (updated_at is the age signal).
    s.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(T0 - 30 * DAY, boundParent);
    const ownPending = await taskIn(s, "pending");
    s.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(T0 - 30 * DAY, ownPending.task_session_id);

    // Scope "subagent": the only scanned candidate is the running attempt's
    // child (kind=subagent) — kept.
    const sub = runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });
    expect(sub.archived_sessions).toBe(0);
    expect(sub.protected_live).toBe(1);

    // Scope "all": every aged session is scanned — the task's own session
    // (running), the pending task's own session, the bound parent, and the
    // running child are ALL live-tied, so nothing archives.
    const all = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ retention_scope: "all" }),
      now: () => T0,
    });
    expect(all.archived_sessions).toBe(0);
    expect(all.protected_live).toBe(4);
    const stillLive = (await s.store.list({ include_archived: true })).map((m) => m.session_id);
    for (const sid of [running.task_session_id, boundParent]) {
      expect(stillLive).toContain(sid);
    }
  });

  it("failed-task ties are kept under scope=subagent, archived under subagent+failed", async () => {
    const s = makeStack();
    const failedChild = await agedSubagent(s, 30);
    const failed = await taskIn(s, "failed", { child_session_id: failedChild });
    s.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(T0 - 30 * DAY, failed.task_session_id);

    const strict = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG(),
      now: () => T0,
    });
    expect(strict.archived_sessions).toBe(0);
    // The failed task's CHILD is scanned (kind=subagent) and kept; the task's
    // own session (kind=session) is outside the "subagent" scan set entirely.
    expect(strict.protected_failed).toBe(1);

    const wide = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ retention_scope: "subagent+failed" }),
      now: () => T0,
    });
    expect(wide.archived_sessions).toBe(2);
    expect((await s.store.read(failedChild)).length).toBe(3); // still readable — from the archive
    // read() of the archived task session works too.
    expect((await s.store.read(failed.task_session_id)).length).toBeGreaterThan(0);
  });

  it("scope=all archives primary sessions too, but never live-tied ones", async () => {
    const s = makeStack();
    const primary = await agedSubagent(s, 30, { kind: "session" });
    const subagent = await agedSubagent(s, 30);
    const liveParent = await agedSubagent(s, 30, { kind: "session" });
    await taskIn(s, "paused", { parent_session_id: liveParent });
    // The task.created/task.paused mirrors touched the parent with the REAL
    // clock — re-age it so the window sees it as the protection target.
    s.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(T0 - 30 * DAY, liveParent);

    const stats = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ retention_scope: "all" }),
      now: () => T0,
    });
    expect(stats.archived_sessions).toBe(2); // primary + subagent
    expect(stats.protected_live).toBe(1); // the paused task's bound parent
    expect((await s.store.read(primary)).length).toBe(3);
    expect((await s.store.read(subagent)).length).toBe(3);
    expect((await s.store.read(liveParent)).length).toBeGreaterThan(0);
    expect(
      (
        s.db.prepare("SELECT archived FROM sessions WHERE id = ?").get(liveParent) as {
          archived: number;
        }
      ).archived,
    ).toBe(0);
  });
});

describe("audit chain (§3.2)", () => {
  it("emits retention.archived / retention.deleted rows and the chain still verifies", async () => {
    const s = makeStack();
    await agedSubagent(s, 10);
    runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });
    const rows = s.db
      .prepare("SELECT actor, action, payload_json FROM audit ORDER BY id")
      .all() as Array<{ actor: string; action: string; payload_json: string }>;
    const archivedRow = rows.find((r) => r.action === "retention.archived");
    expect(archivedRow).toBeDefined();
    expect(archivedRow!.actor).toBe(RETENTION_TASK_ID);
    const payload = JSON.parse(archivedRow!.payload_json) as Record<string, unknown>;
    expect(payload).toMatchObject({ archived_sessions: 1, archived_events: 3, scope: "subagent" });

    expect(verifyAuditChain(s.db).ok).toBe(true);

    // The deletion pass appends its own audited row.
    runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ delete_after_days: 1 }),
      now: () => T0 + 2 * DAY,
    });
    const rows2 = s.db.prepare("SELECT action FROM audit ORDER BY id").all() as Array<{
      action: string;
    }>;
    expect(rows2.some((r) => r.action === "retention.deleted")).toBe(true);
    expect(verifyAuditChain(s.db).ok).toBe(true);
  });

  it("emits no audit rows when nothing happened (the task log records the no-op)", async () => {
    const s = makeStack();
    await agedSubagent(s, 1); // inside the window
    runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });
    const rows = s.db.prepare("SELECT COUNT(*) AS n FROM audit").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("hard deletion (§3.2 — opt-in, archived only)", () => {
  it("deletes archived sessions past delete_after_days: archive events + the sessions row", async () => {
    const s = makeStack();
    const sid = await agedSubagent(s, 10);
    runRetention({ db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 });

    // Not yet old enough.
    const early = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ delete_after_days: 30 }),
      now: () => T0 + 10 * DAY,
    });
    expect(early.deleted_sessions).toBe(0);

    // Past the horizon: gone from both files.
    const late = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ delete_after_days: 30 }),
      now: () => T0 + 31 * DAY,
    });
    expect(late).toMatchObject({ deleted_sessions: 1, deleted_events: 3 });
    expect(await s.store.meta(sid)).toBeNull();
    expect(
      (
        s.db.prepare("SELECT COUNT(*) AS n FROM archive.events WHERE session_id = ?").get(sid) as {
          n: number;
        }
      ).n,
    ).toBe(0);
  });

  it("never hard-deletes live or soft-archived sessions", async () => {
    const s = makeStack();
    const live = await agedSubagent(s, 1); // inside window, never archived
    const soft = await agedSubagent(s, 10);
    await s.store.archiveSession(soft); // Phase 3 soft-archive (archived_at set, archived still 0)

    const stats = runRetention({
      db: s.db,
      archivePath: ":memory:",
      config: CFG({ delete_after_days: 1 }),
      now: () => T0 + 100 * DAY,
    });
    expect(stats.deleted_sessions).toBe(0); // nothing is retention-archived
    expect(await s.store.meta(live)).not.toBeNull();
    expect(await s.store.meta(soft)).not.toBeNull();
    expect((await s.store.read(soft)).length).toBe(3); // soft-archived keeps its events in main
  });
});

describe("the durable task (§3 — scheduled task, not a startup sweep)", () => {
  it("retentionTaskSpec creates as a system task, recurring at the configured cron", async () => {
    const s = makeStack();
    const spec = retentionTaskSpec({ retention_schedule: "30 3 * * *" });
    const rec = await s.manager.create(spec, OWNER, { system: true });
    expect(rec.id).toBe(RETENTION_TASK_ID);
    expect(rec.state).toBe("pending");
    expect(rec.spec.schedule).toBe("30 3 * * *");
    expect(rec.next_attempt_at).toBeGreaterThan(T0); // first fire — NOT now

    // The nyx: prefix is refused for non-system callers.
    await expect(s.manager.create(spec, OWNER)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });

  it("ensureRetentionTask: creates when absent, revives terminal, leaves paused alone", async () => {
    const s = makeStack();
    await ensureRetentionTask(s.manager, { retention_schedule: "30 3 * * *" }, OWNER);
    let rec = await s.manager.get(RETENTION_TASK_ID);
    expect(rec!.state).toBe("pending");

    // Idempotent: a second call changes nothing.
    await ensureRetentionTask(s.manager, { retention_schedule: "30 3 * * *" }, OWNER);
    expect((await s.manager.get(RETENTION_TASK_ID))!.state).toBe("pending");

    // Cancelled → revived (the config is the source of truth for system tasks).
    await s.manager.cancel(RETENTION_TASK_ID);
    await ensureRetentionTask(s.manager, { retention_schedule: "30 3 * * *" }, OWNER);
    rec = await s.manager.get(RETENTION_TASK_ID);
    expect(rec!.state).toBe("pending");

    // Paused → untouched (an explicit operator action, resume-able).
    await s.manager.pause(RETENTION_TASK_ID);
    await ensureRetentionTask(s.manager, { retention_schedule: "30 3 * * *" }, OWNER);
    expect((await s.manager.get(RETENTION_TASK_ID))!.state).toBe("paused");
  });

  it("runRetentionAttempt synthesizes a completed SubagentResult with the counts", async () => {
    const s = makeStack();
    await agedSubagent(s, 10);
    const result = await runRetentionAttempt(
      { db: s.db, archivePath: ":memory:", config: CFG(), now: () => T0 },
      "task-session",
      T0,
      () => T0 + 5,
    );
    expect(result.state).toBe("completed");
    expect(result.session_id).toBe("task-session");
    expect(result.tokens_used).toBe(0);
    expect(result.summary).toContain("archived 1 session(s)");
    expect(result.summary).toContain("3 event(s)");
  });
});

describe("the archive file (§3)", () => {
  it("a file-backed nyx.db gets a real nyx-archive.db sibling, readable cross-connection", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-retention-"));
    const mainPath = path.join(dir, "nyx.db");
    const archivePath = path.join(dir, "nyx-archive.db");
    const db = new Database(mainPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    const store = openSessionStore(mainPath, { db, archivePath });
    try {
      const meta = await store.create({ owner_id: "o", persona_id: "p", kind: "subagent" });
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
        T0 - 30 * DAY,
        meta.session_id,
      );
      const stats = runRetention({ db, archivePath, config: CFG(), now: () => T0 });
      expect(stats.archived_sessions).toBe(1);

      // The sibling file exists on disk…
      const stat = await fsp.stat(archivePath);
      expect(stat.size).toBeGreaterThan(0);
      // …and a FRESH connection to it serves the archived events.
      const reader = new Database(archivePath);
      try {
        const n = reader
          .prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?")
          .get(meta.session_id) as { n: number };
        expect(n.n).toBe(1); // just session.created
      } finally {
        reader.close();
      }
    } finally {
      store.close();
      db.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
