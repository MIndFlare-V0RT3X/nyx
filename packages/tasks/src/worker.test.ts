// SPDX-License-Identifier: AGPL-3.0-or-later
// Worker-pool tests: the §2.1.7 acceptance scenarios — retry ladder with
// exactly one task.retrying per failed attempt, pause/cancel during a run,
// lease expiry + reclaim (crash simulation), two-worker contention with an
// artificial 100ms claim-path sleep, restart semantics (unexpired leases
// wait, expired leases reclaim), graceful-shutdown release (owner kept,
// expiry moved), recurring cron reset without double-fire, renewal keeping
// a long run's lease alive, and the no-orphan guarantee for subagent
// sessions.

import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openSessionStore } from "@nyx/session";
import type {
  SessionStore,
  SubagentResult,
  TaskRecord,
} from "@nyx/protocol";
import {
  TaskWorkerPool,
  backoffAt,
  createTaskManager,
  type TaskManager,
  type TaskRunner,
} from "./index.js";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const OWNER = { owner_id: "test-owner", persona_id: "test-persona" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Stack {
  db: Database.Database;
  store: SessionStore;
  manager: TaskManager;
  clock: { now: number };
  close(): Promise<void>;
}

const stacks: Stack[] = [];

function baseSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "fuzz parser",
    description: "Fuzz the parser and report.",
    subagent_spec: { budget_tokens: 2048 },
    max_attempts: 3,
    retry_backoff_ms: 1000,
    ...over,
  };
}

async function makeStack(db?: Database.Database): Promise<Stack> {
  const owns = db === undefined;
  const handle = db ?? new Database(":memory:");
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  const store = openSessionStore(":memory:", { db: handle });
  const clock = { now: T0 };
  const manager = createTaskManager({ db: handle, store, now: () => clock.now });
  const stack: Stack = {
    db: handle,
    store,
    manager,
    clock,
    close: async () => {
      store.close();
      if (owns) handle.close();
    },
  };
  stacks.push(stack);
  return stack;
}

/**
 * A REALISTIC runner: creates a real subagent session per attempt (kind
 * subagent, parent = the task's session), reports it through the handle,
 * holds until the outcome or the abort signal, and appends the terminal
 * subagent.* event to the child log exactly the way SubagentManager.spawn
 * does. Returns the SubagentResult.
 */
function realisticRunner(
  store: SessionStore,
  outcomes: Array<"completed" | "failed">,
  opts: { hold_ms?: number } = {},
): TaskRunner & { calls: TaskRecord[]; childSessions: string[] } {
  const calls: TaskRecord[] = [];
  const childSessions: string[] = [];
  let seq = 0;
  return {
    calls,
    childSessions,
    async run(task, handle): Promise<SubagentResult> {
      calls.push(task);
      seq += 1;
      const child = await store.create({
        owner_id: "test-owner",
        persona_id: "test-persona",
        parent_id: task.task_session_id,
        kind: "subagent",
        title: `subagent: attempt ${seq}`,
      });
      childSessions.push(child.session_id);
      handle.setSubagentSession(child.session_id);

      // Hold the attempt open; resolve early on abort.
      if (opts.hold_ms !== undefined) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.hold_ms);
          handle.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }

      if (handle.signal.aborted) {
        await store.append(child.session_id, [
          {
            type: "subagent.aborted",
            session_id: child.session_id,
            subagent_session_id: child.session_id,
            parent_session_id: task.task_session_id,
            reason: "abort requested",
            ts: Date.now(),
          },
        ]);
        return {
          session_id: child.session_id,
          summary: "",
          state: "aborted",
          tokens_used: 0,
          duration_ms: 0,
          error: { name: "AbortError", message: "abort requested", code: "aborted" },
        };
      }
      const outcome = outcomes.length > 0 ? outcomes.shift()! : "completed";
      if (outcome === "completed") {
        await store.append(child.session_id, [
          {
            type: "subagent.completed",
            session_id: child.session_id,
            subagent_session_id: child.session_id,
            parent_session_id: task.task_session_id,
            summary: "fuzzed 100 cases, 0 crashes",
            tokens_used: 4200,
            duration_ms: 12_000,
            ts: Date.now(),
          },
        ]);
        return {
          session_id: child.session_id,
          summary: "fuzzed 100 cases, 0 crashes",
          state: "completed",
          tokens_used: 4200,
          duration_ms: 12_000,
        };
      }
      const error = { name: "ProviderError", message: "model stream failed", code: "provider_error" };
      await store.append(child.session_id, [
        {
          type: "subagent.failed",
          session_id: child.session_id,
          subagent_session_id: child.session_id,
          parent_session_id: task.task_session_id,
          error,
          ts: Date.now(),
        },
      ]);
      return {
        session_id: child.session_id,
        summary: "",
        state: "failed",
        tokens_used: 0,
        duration_ms: 0,
        error,
      };
    },
    async abort(_task) {
      // Signal-driven: the pool's controller is the abort path.
    },
  };
}

function makePool(
  s: Stack,
  runner: TaskRunner,
  cfg: Record<string, unknown> = {},
): TaskWorkerPool {
  return new TaskWorkerPool({
    manager: s.manager,
    runner,
    store: s.store,
    now: () => s.clock.now,
    config: cfg as never,
  });
}

afterAll(async () => {
  while (stacks.length > 0) await stacks.pop()!.close();
});

describe("retry ladder (§2.1.7)", () => {
  it("fails twice, succeeds third: completed, attempts=3, one task.retrying per failure", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["failed", "failed", "completed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);

    // Attempt 1 fails → retrying (backoff 1s).
    expect(await pool.pollOnce()).toBe(1);
    let row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.next_attempt_at).toBe(T0 + 1000);

    // Not due until the backoff elapses.
    s.clock.now = T0 + 500;
    expect(await pool.pollOnce()).toBe(0);

    // Attempt 2 fails → retrying (backoff 4s — monotonic).
    s.clock.now = T0 + 1000;
    expect(await pool.pollOnce()).toBe(1);
    row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(2);
    expect(row!.next_attempt_at).toBe(T0 + 1000 + 4000);
    expect(row!.next_attempt_at!).toBeGreaterThan(T0 + 1000);

    s.clock.now = T0 + 5000;
    expect(await pool.pollOnce()).toBe(1);
    row = await s.manager.get(rec.id);
    expect(row!.state).toBe("completed");
    expect(row!.attempts).toBe(3);
    expect(row!.result!.summary).toBe("fuzzed 100 cases, 0 crashes");

    const events = await s.store.read(rec.task_session_id);
    const retrying = events.filter((e) => e.type === "task.retrying");
    expect(retrying).toHaveLength(2);
    expect(events.filter((e) => e.type === "task.started")).toHaveLength(3);
    expect(events.filter((e) => e.type === "task.completed")).toHaveLength(1);
    expect(events.filter((e) => e.type === "task.failed")).toHaveLength(0);
  });

  it("fails to the cap: terminal failed with one task.failed", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["failed", "failed", "failed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    for (let i = 1; i <= 3; i++) {
      s.clock.now = T0 + i * 10_000;
      await pool.pollOnce();
    }
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("failed");
    expect(row!.attempts).toBe(3);
    expect(row!.last_error!.message).toBe("model stream failed");
    const events = await s.store.read(rec.task_session_id);
    expect(events.filter((e) => e.type === "task.failed")).toHaveLength(1);
    // attempts exhausted: no further claim
    s.clock.now = T0 + 1_000_000;
    expect(await pool.pollOnce()).toBe(0);
  });

  it("backoff is monotonic across attempts (1s → 4s → 16s)", () => {
    expect(backoffAt(1000, 1, 0)).toBe(1000);
    expect(backoffAt(1000, 2, 0)).toBe(4000);
    expect(backoffAt(1000, 3, 0)).toBe(16000);
    expect(backoffAt(0, 3, 500)).toBe(500);
    const times = [1, 2, 3, 4].map((a) => backoffAt(1000, a, 100));
    for (let i = 1; i < times.length; i++) expect(times[i]!).toBeGreaterThan(times[i - 1]!);
  });
});

describe("pause / cancel during a run (§2.1.7)", () => {
  it("pause during running: paused, resume restores pending, a worker reclaims", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, [], { hold_ms: 400 });
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);

    // Run the attempt in the background; pause while it holds.
    const running = pool.pollOnce();
    await sleep(50);
    expect(pool.runningCount).toBe(1);
    await s.manager.pause(rec.id);
    let row = await s.manager.get(rec.id);
    expect(row!.state).toBe("paused");

    await running; // the aborted attempt settles nothing
    row = await s.manager.get(rec.id);
    expect(row!.state).toBe("paused");
    const events = await s.store.read(rec.task_session_id);
    expect(events.some((e) => e.type === "task.paused")).toBe(true);
    expect(events.some((e) => e.type === "task.retrying")).toBe(false);

    // A paused task is never reclaimed.
    s.clock.now = T0 + 10_000_000;
    expect(await pool.pollOnce()).toBe(0);

    await s.manager.resume(rec.id);
    row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.next_attempt_at).toBeNull();
    expect(await pool.pollOnce()).toBe(1);
    row = await s.manager.get(rec.id);
    expect(row!.state).toBe("completed");
    expect(runner.calls).toHaveLength(2);
  });

  it("cancel during running: cancelled; the child session ends with subagent.aborted", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, [], { hold_ms: 400 });
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);

    const running = pool.pollOnce();
    await sleep(50);
    await s.manager.cancel(rec.id);
    await running;

    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("cancelled");
    const child = row!.subagent_session_id;
    expect(child).not.toBeNull();
    const childEvents = await s.store.read(child!);
    const terminal = childEvents.filter((e) => e.type.startsWith("subagent."));
    expect(terminal[terminal.length - 1]!.type).toBe("subagent.aborted");

    // cancelled is terminal: no reclaims
    s.clock.now = T0 + 10_000_000;
    expect(await pool.pollOnce()).toBe(0);
    await expect(s.manager.resume(rec.id)).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });
});

describe("leases (§2.1.3 / §2.1.7)", () => {
  it("an expired lease (crash simulation) is reclaimed by a second worker", async () => {
    const s = await makeStack();
    // A worker claims and "crashes": the row stays running under its lease.
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    const crash = s.manager.sql.claim(rec.id, "crashed-worker", 60_000, T0);
    expect(crash.claimed).toBe(true);

    const runner = realisticRunner(s.store, ["completed"]);
    const pool = makePool(s, runner);

    // Before expiry: not a candidate.
    s.clock.now = T0 + 59_999;
    expect(await pool.pollOnce()).toBe(0);
    // After expiry: reclaimed.
    s.clock.now = T0 + 60_001;
    expect(await pool.pollOnce()).toBe(1);
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("completed");
    // The reclaim consumed the crashed owner's attempt (R2-5): crash-claim
    // kept attempts at 0, the foreign reclaim bumped it to 1, and the live
    // attempt that succeeded was attempt 2.
    expect(row!.attempts).toBe(2);
  });

  it("two workers on the same nyx.db never double-run (100ms claim-path sleep)", async () => {
    // Two full stacks on the same FILE, separate handles — the cross-process
    // shape. Both scan, both sleep 100ms in the claim path, both claim:
    // exactly one wins the conditional UPDATE.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-tasks-race-"));
    const file = path.join(dir, "nyx.db");
    const handles: Database.Database[] = [];
    try {
      const dbA = new Database(file);
      handles.push(dbA);
      dbA.pragma("journal_mode = WAL");
      dbA.pragma("busy_timeout = 5000");
      const sA = await makeStack(dbA);
      const dbB = new Database(file);
      handles.push(dbB);
      dbB.pragma("busy_timeout = 5000");
      const sB = await makeStack(dbB);

      const rec = await sA.manager.create(baseSpec() as never, OWNER);
      expect(await sB.manager.get(rec.id)).not.toBeNull();

      const runnerA = realisticRunner(sA.store, [], { hold_ms: 120 });
      const runnerB = realisticRunner(sB.store, [], { hold_ms: 120 });
      const poolA = new TaskWorkerPool({
        manager: sA.manager,
        runner: runnerA,
        store: sA.store,
        now: () => sA.clock.now,
        config: { claim_delay_ms: 100 },
      });
      const poolB = new TaskWorkerPool({
        manager: sB.manager,
        runner: runnerB,
        store: sB.store,
        now: () => sB.clock.now,
        config: { claim_delay_ms: 100 },
      });

      const passA = poolA.pollOnce();
      const passB = poolB.pollOnce();
      await Promise.all([passA, passB]);

      expect(runnerA.calls.length + runnerB.calls.length).toBe(1);
      const row = await sB.manager.get(rec.id);
      expect(row!.state).toBe("completed");
      expect(row!.attempts).toBe(1);
    } finally {
      for (const h of handles) h.close();
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it("restart semantics: unexpired lease waits, expired lease reclaims", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    // A worker from a previous "process" holds a 5-minute lease.
    s.manager.sql.claim(rec.id, "previous-process", 300_000, T0);

    const runner = realisticRunner(s.store, ["completed"]);
    const pool = makePool(s, runner);
    // New process boots, polls at +1min: unexpired lease is not a candidate.
    s.clock.now = T0 + 60_000;
    expect(await pool.pollOnce()).toBe(0);
    // At +6min the lease has expired: reclaimed.
    s.clock.now = T0 + 360_000;
    expect(await pool.pollOnce()).toBe(1);
    expect((await s.manager.get(rec.id))!.state).toBe("completed");
  });

  it("renewal keeps a long run's lease alive past multiple TTLs (real clock)", async () => {
    // The old version of this test was vacuous (§6.1 fan-out): the pool's
    // mock clock never advanced, so the lease could never lapse in the
    // competitor's eyes regardless of renewal. Real clocks on both pools:
    // TTL 200ms, renewal every 40ms, a 700ms hold — the competitor polls
    // twice, each time MORE than one TTL past the claim, and must find no
    // reclaim window as long as renewal holds.
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    const runner = realisticRunner(s.store, ["completed"], { hold_ms: 700 });
    const realNow = (): number => Date.now();
    const pool = new TaskWorkerPool({
      manager: s.manager,
      runner,
      store: s.store,
      now: realNow,
      config: { lease_ttl_ms: 200, renew_interval_ms: 40 },
    });
    const competitor = new TaskWorkerPool({
      manager: s.manager,
      runner: realisticRunner(s.store, []),
      store: s.store,
      now: realNow,
      config: {},
    });

    const running = pool.pollOnce();
    await sleep(250); // > 1 TTL past the claim
    expect(pool.runningCount).toBe(1);
    // The renewal kept the expiry ahead of the real clock: no reclaim.
    expect(await competitor.pollOnce()).toBe(0);
    await sleep(250); // > another TTL
    expect(pool.runningCount).toBe(1);
    expect(await competitor.pollOnce()).toBe(0);
    await running;
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("completed");
    expect(runner.calls).toHaveLength(1);
  });

  it("graceful shutdown aborts the attempt and RELEASES (not clears) the lease", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    const runner = realisticRunner(s.store, [], { hold_ms: 400 });
    const pool = makePool(s, runner, { lease_ttl_ms: 300_000 });
    pool.start();
    await sleep(80);
    expect(pool.runningCount).toBe(1);

    await pool.stop();
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("running");
    // Released: the owner name stays, the expiry moved to now.
    expect(row!.lease_owner).not.toBeNull();
    expect(row!.lease_owner).toBe(pool.workerIds[0]);
    expect(row!.lease_expires_at!).toBeLessThanOrEqual(s.clock.now + 1);

    // Another worker reclaims immediately.
    const next = makePool(s, realisticRunner(s.store, ["completed"]));
    expect(await next.pollOnce()).toBe(1);
    expect((await s.manager.get(rec.id))!.state).toBe("completed");
  });

  it("a stolen lease (renewal lost) does not double-settle", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    const runner = realisticRunner(s.store, [], { hold_ms: 150 });
    // renew < ttl (the R1-5 validation, enforced by the pool constructor and
    // the config schema alike). The mock clock is frozen at T0, so the
    // pool's renewals keep re-writing the same expiry (T0+500) while the
    // thief claims at T0+1000 — past it regardless of the renew cadence.
    const pool = makePool(s, runner, { lease_ttl_ms: 500, renew_interval_ms: 100 });
    const running = pool.pollOnce();
    await sleep(20);
    // A second worker force-reclaims by claiming after expiry.
    s.manager.sql.claim(rec.id, "thief", 300_000, s.clock.now + 1000);
    await running;
    // The original worker's settle hits lease_lost and emits nothing; the
    // thief's row is intact.
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("running");
    expect(row!.lease_owner).toBe("thief");
  });
});

describe("recurring tasks (§2.1.5 / §2.1.7)", () => {
  it("fires, completes, resets, and fires again on schedule (mock clock)", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["completed", "completed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(
      baseSpec({ schedule: "*/5 * * * *" }) as never,
      OWNER,
    );
    // T0 = 00:00 → first fire 00:05.
    expect(rec.next_attempt_at).toBe(T0 + 300_000);

    // Before the first fire: not due.
    s.clock.now = T0 + 299_999;
    expect(await pool.pollOnce()).toBe(0);

    // 00:05 — fires, completes, resets to pending at 00:10, attempts 0.
    s.clock.now = T0 + 300_000;
    expect(await pool.pollOnce()).toBe(1);
    let row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.next_attempt_at).toBe(T0 + 600_000);

    // The reset cannot double-fire in the same window.
    s.clock.now = T0 + 300_001;
    expect(await pool.pollOnce()).toBe(0);
    s.clock.now = T0 + 599_999;
    expect(await pool.pollOnce()).toBe(0);

    // 00:10 — fires again.
    s.clock.now = T0 + 600_000;
    expect(await pool.pollOnce()).toBe(1);
    row = await s.manager.get(rec.id);
    expect(runner.calls).toHaveLength(2);
    expect(row!.next_attempt_at).toBe(T0 + 900_000);

    const events = await s.store.read(rec.task_session_id);
    expect(events.filter((e) => e.type === "task.completed")).toHaveLength(2);
    expect(events.filter((e) => e.type === "task.retrying")).toHaveLength(0);
  });

  it("a recurring task that fails retries, and does not reset until success", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["failed", "completed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(
      baseSpec({ schedule: "*/5 * * * *", retry_backoff_ms: 1000 }) as never,
      OWNER,
    );
    s.clock.now = T0 + 300_000;
    await pool.pollOnce(); // fails → pending with backoff, NOT cron reset
    let row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.next_attempt_at).toBe(T0 + 300_000 + 1000);
    s.clock.now = T0 + 301_000;
    await pool.pollOnce(); // succeeds → cron reset
    row = await s.manager.get(rec.id);
    expect(row!.attempts).toBe(0);
    expect(row!.next_attempt_at).toBe(T0 + 600_000);
  });
});

describe("no orphaned subagent sessions (§2.1.7)", () => {
  it("every task's subagent_session_id is a real session, always", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["failed", "failed", "completed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    const rec2 = await s.manager.create(baseSpec({ title: "two" }) as never, OWNER);

    s.clock.now = T0 + 10_000;
    await pool.pollOnce(); // rec: attempt 1 fails
    s.clock.now = T0 + 20_000;
    await pool.pollOnce(); // rec: attempt 2 aborted → failure ladder
    s.clock.now = T0 + 80_000;
    await pool.pollOnce(); // rec: attempt 3 completed
    s.clock.now = T0 + 90_000;
    await pool.pollOnce(); // rec2 completed

    for (const id of [rec.id, rec2.id]) {
      const row = await s.manager.get(id);
      if (row!.subagent_session_id !== null) {
        const meta = await s.store.meta(row!.subagent_session_id);
        expect(meta).not.toBeNull();
        expect(meta!.kind).toBe("subagent");
      }
    }
    for (const sid of runner.childSessions) {
      const meta = await s.store.meta(sid);
      expect(meta).not.toBeNull();
    }
    expect(runner.childSessions.length).toBeGreaterThanOrEqual(4);
  });
});

describe("task.started / task.completed events", () => {
  it("carry attempts and land on the task's own log", async () => {
    const s = await makeStack();
    const runner = realisticRunner(s.store, ["completed"]);
    const pool = makePool(s, runner);
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    await pool.pollOnce();
    const events = await s.store.read(rec.task_session_id);
    const started = events.find((e) => e.type === "task.started");
    expect(started).toMatchObject({ task_id: rec.id, attempt: 1 });
    const completed = events.find((e) => e.type === "task.completed");
    expect(completed).toMatchObject({ task_id: rec.id, attempts: 1 });
  });
});
