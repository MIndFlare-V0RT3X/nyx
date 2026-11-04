// SPDX-License-Identifier: AGPL-3.0-or-later
// TaskManager tests: creation (owner/persona inheritance, task session,
// event mirroring), the full state-machine matrix (every state is REACHED
// through public transitions — reachability is half the proof — and every
// illegal edge throws), and the reserved-id / validation guards.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openSessionStore } from "@nyx/session";
import {
  TASK_TRANSITIONS,
  type SessionStore,
  type TaskRecord,
  type TaskState,
} from "@nyx/protocol";
import { createTaskManager, type TaskManager } from "./index.js";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);
const OWNER = { owner_id: "test-owner", persona_id: "test-persona" };

interface Stack {
  db: Database.Database;
  store: SessionStore;
  manager: TaskManager;
  clock: { now: number };
}

const stacks: Stack[] = [];

async function makeStack(): Promise<Stack> {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const store = openSessionStore(":memory:", { db });
  const clock = { now: T0 };
  const manager = createTaskManager({ db, store, now: () => clock.now });
  const stack = { db, store, manager, clock };
  stacks.push(stack);
  return stack;
}

function baseSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "fuzz parser",
    description: "Fuzz the parser for a while and report findings.",
    subagent_spec: { budget_tokens: 2048 },
    max_attempts: 3,
    retry_backoff_ms: 1000,
    ...over,
  };
}

/**
 * Park a fresh task in `state` using ONLY public manager/store transitions —
 * the reachability half of the state-machine proof.
 */
async function parkedAt(
  s: Stack,
  state: TaskState,
): Promise<TaskRecord> {
  const rec = await s.manager.create(baseSpec() as never, OWNER);
  switch (state) {
    case "pending":
      return rec;
    case "running":
      s.manager.sql.claim(rec.id, "park-worker", 300_000, s.clock.now);
      return (await s.manager.get(rec.id))!;
    case "paused":
      await s.manager.pause(rec.id);
      return (await s.manager.get(rec.id))!;
    case "completed":
      s.manager.sql.claim(rec.id, "park-worker", 300_000, s.clock.now);
      s.manager.sql.settleRunning(rec.id, "park-worker", "completed", { attempts: 1 });
      return (await s.manager.get(rec.id))!;
    case "failed":
      s.manager.sql.claim(rec.id, "park-worker", 300_000, s.clock.now);
      s.manager.sql.settleRunning(rec.id, "park-worker", "failed", {
        attempts: 3,
        last_error: { name: "Error", message: "parked failure" },
      });
      return (await s.manager.get(rec.id))!;
    case "cancelled":
      await s.manager.cancel(rec.id);
      return (await s.manager.get(rec.id))!;
  }
}

afterAll(async () => {
  while (stacks.length > 0) {
    const s = stacks.pop()!;
    s.store.close();
    s.db.close();
  }
});

describe("task creation", () => {
  it("creates a pending task with its own titled session, due immediately", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    expect(rec.state).toBe("pending");
    expect(rec.attempts).toBe(0);
    expect(rec.next_attempt_at).toBeNull();
    expect(rec.spec.max_attempts).toBe(3);
    expect(rec.spec.retry_backoff_ms).toBe(1000);
    // The task's own session is real and titled.
    const meta = await s.store.meta(rec.task_session_id);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("task: fuzz parser");
    expect(meta!.owner_id).toBe("test-owner");
    const got = await s.manager.get(rec.id);
    expect(got!.task_session_id).toBe(rec.task_session_id);
  });

  it("rejects a nyx:-prefixed caller id (reserved for system tasks)", async () => {
    const s = await makeStack();
    await expect(
      s.manager.create(baseSpec({ id: "nyx:evil" }) as never, OWNER),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("rejects an invalid spec (Zod-validated, task text smuggling refused)", async () => {
    const s = await makeStack();
    await expect(
      s.manager.create(baseSpec({ max_attempts: 0 }) as never, OWNER),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(
      s.manager.create(baseSpec({ subagent_spec: { task: "smuggled" } }) as never, OWNER),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("inherits owner from the bound parent and refuses cross-owner creation", async () => {
    const s = await makeStack();
    const parent = await s.store.create({ owner_id: "alice", persona_id: "persona-x" });
    const rec = await s.manager.create(
      baseSpec({ parent_session_id: parent.session_id }) as never,
      { owner_id: "alice", persona_id: "whatever" },
    );
    expect(rec.spec.parent_session_id).toBe(parent.session_id);
    // task.created mirrored onto BOTH logs
    const taskEvents = await s.store.read(rec.task_session_id);
    const parentEvents = await s.store.read(parent.session_id);
    expect(taskEvents.some((e) => e.type === "task.created")).toBe(true);
    expect(parentEvents.some((e) => e.type === "task.created")).toBe(true);
    // cross-owner refused (hard rule #6)
    await expect(
      s.manager.create(baseSpec({ parent_session_id: parent.session_id }) as never, {
        owner_id: "mallory",
        persona_id: "p",
      }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("refuses a bound task whose parent session does not exist", async () => {
    const s = await makeStack();
    await expect(
      s.manager.create(baseSpec({ parent_session_id: "nope" }) as never, OWNER),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates the cron schedule and sets next_attempt_at to the first fire", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec({ schedule: "*/5 * * * *" }) as never, OWNER);
    // T0 = 2026-01-01T00:00:00Z → first fire 00:05
    expect(rec.next_attempt_at).toBe(T0 + 5 * 60_000);
    await expect(
      s.manager.create(baseSpec({ schedule: "not a cron" }) as never, OWNER),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("lists by state and parent_session_id", async () => {
    const s = await makeStack();
    const parent = await s.store.create({ owner_id: "test-owner", persona_id: "p" });
    const a = await s.manager.create(baseSpec({ title: "a" }) as never, OWNER);
    const b = await s.manager.create(baseSpec({ title: "b" }) as never, OWNER);
    const bound = await s.manager.create(
      baseSpec({ title: "bound", parent_session_id: parent.session_id }) as never,
      OWNER,
    );
    await s.manager.pause(b.id);
    expect((await s.manager.list({ state: ["pending"] })).map((r) => r.id).sort()).toEqual(
      [bound.id, a.id].sort(),
    );
    expect((await s.manager.list({ state: ["paused"] })).map((r) => r.id)).toEqual([b.id]);
    expect(
      (await s.manager.list({ parent_session_id: parent.session_id })).map((r) => r.id),
    ).toEqual([bound.id]);
    expect(await s.manager.list({ state: ["running"] })).toEqual([]);
  });
});

describe("state machine (hard rule #1: illegal transitions throw)", () => {
  const STATES: TaskState[] = [
    "pending",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
  ];

  it("every state is reachable through public transitions", async () => {
    const s = await makeStack();
    for (const state of STATES) {
      const rec = await parkedAt(s, state);
      expect(rec.state).toBe(state);
    }
  });

  it("exhaustive matrix: every legal edge works, every illegal edge throws", async () => {
    const s = await makeStack();
    for (const from of STATES) {
      for (const to of STATES) {
        if (from === to) continue;
        const legal = TASK_TRANSITIONS[from].includes(to);
        const rec = await parkedAt(s, from);
        const attempt = async (): Promise<void> => {
          switch (to) {
            case "running": {
              // claim is the only path into running. Contention is reported
              // as claimed=false — surfaced here as the illegal edge it is.
              const c = s.manager.sql.claim(rec.id, "matrix-worker", 300_000, s.clock.now);
              if (!c.claimed) {
                throw Object.assign(new Error(`cannot claim from ${from}`), {
                  code: "illegal_transition",
                });
              }
              return;
            }
            case "paused":
              await s.manager.pause(rec.id);
              return;
            case "pending":
              // resume() covers paused; retry() covers failed/cancelled; the
              // worker's settleRunning covers running (backoff reset).
              if (from === "paused") await s.manager.resume(rec.id);
              else if (from === "running")
                s.manager.sql.settleRunning(rec.id, "park-worker", "pending", {
                  attempts: 1,
                  next_attempt_at: s.clock.now + 1000,
                });
              else await s.manager.retry(rec.id);
              return;
            case "cancelled":
              await s.manager.cancel(rec.id);
              return;
            case "completed":
            case "failed": {
              // Worker-only settlements: legal ONLY from running under the
              // lease the row actually holds (park-worker).
              s.manager.sql.settleRunning(rec.id, "park-worker", to, {
                attempts: 1,
                ...(to === "failed" ? { last_error: { name: "Error", message: "x" } } : {}),
              });
              return;
            }
          }
        };
        if (legal) {
          await attempt();
          const after = await s.manager.get(rec.id);
          expect(after!.state).toBe(to);
        } else {
          // The refusal code is determined by WHICH path the edge takes:
          // the claim (to=running) and the public transitions (pause/
          // resume/cancel/retry) refuse with illegal_transition; the
          // worker-only settleRunning (to=completed|failed) refuses a
          // non-running row with lease_lost — R2-2: never fake-succeeds,
          // never misreports a lost row as an illegal edge. Pinning the
          // code per path (rather than accepting either anywhere) makes
          // the matrix exact: a regression that swaps one refusal for the
          // other fails here.
          const settlePath = to === "completed" || to === "failed";
          await expect(attempt()).rejects.toSatisfy(
            (e: unknown) =>
              e instanceof Error &&
              (settlePath
                ? (e as { code?: string }).code === "lease_lost"
                : (e as { code?: string }).code === "illegal_transition"),
          );
        }
      }
    }
  });

  it("settleRunning refuses from a foreign lease and from a non-running row", async () => {
    const s = await makeStack();
    const rec = await parkedAt(s, "running");
    expect(() =>
      s.manager.sql.settleRunning(rec.id, "w-other", "completed", { attempts: 1 }),
    ).toThrow(/lease/);
    const settled = s.manager.sql.settleRunning(rec.id, "park-worker", "completed", {
      attempts: 1,
      result: null,
    });
    expect(settled.state).toBe("completed");
    // Fan-out review R2-2: a non-running row is ALWAYS lease_lost — even when
    // the observed state already equals the target.
    expect(() =>
      s.manager.sql.settleRunning(rec.id, "park-worker", "completed", { attempts: 1 }),
    ).toThrow(/no longer running/);
    expect(() =>
      s.manager.sql.settleRunning(rec.id, "park-worker", "failed", { attempts: 1 }),
    ).toThrow(/no longer running/);
  });

  it("retry() resets attempts and returns failed/cancelled → pending", async () => {
    const s = await makeStack();
    const rec = await parkedAt(s, "failed");
    expect(rec.attempts).toBe(3);
    await s.manager.retry(rec.id);
    const after = await s.manager.get(rec.id);
    expect(after!.state).toBe("pending");
    expect(after!.attempts).toBe(0);
    expect(after!.next_attempt_at).toBeNull();
    await expect(s.manager.retry(rec.id)).rejects.toMatchObject({
      code: "illegal_transition",
    });
  });

  it("cancel is idempotent from cancelled (any-state cancel, §2.1.4)", async () => {
    const s = await makeStack();
    const rec = await parkedAt(s, "cancelled");
    await expect(s.manager.cancel(rec.id)).resolves.toBeUndefined();
  });
});

describe("claim guards (§6.1 fan-out: R2-1 / R2-5 / R2-6)", () => {
  it("R2-1: a task with next_attempt_at in the future is not claimed by a worker polling now", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec() as never, OWNER);
    // A retry backoff (or a cron window) has parked the task in the future.
    s.manager.sql.setNextAttemptAt(rec.id, T0 + 5000);

    // The worker's poll is candidates() + claim() — both refuse the
    // not-yet-due row: without the guard, a stale candidate scan bypasses
    // retry backoff and can double-fire a recurring task in its window.
    expect(s.manager.sql.candidates(s.clock.now)).toEqual([]);
    expect(s.manager.sql.claim(rec.id, "w-now", 300_000, s.clock.now).claimed).toBe(false);
    expect((await s.manager.get(rec.id))!.state).toBe("pending");

    // At the due instant the same poll claims it.
    expect(s.manager.sql.candidates(T0 + 5000)).toEqual([rec.id]);
    const at = s.manager.sql.claim(rec.id, "w-now", 300_000, T0 + 5000);
    expect(at.claimed).toBe(true);
    expect(at.task!.state).toBe("running");
    expect(at.task!.lease_owner).toBe("w-now");
  });

  it("R2-5: repeated crashes increment attempts on each reclaim and converge to failed at max_attempts", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(baseSpec({ max_attempts: 3 }) as never, OWNER);
    expect(rec.attempts).toBe(0);

    // Crash loop: a worker claims, "dies" (lease left to expire), the next
    // worker reclaims. Every FOREIGN reclaim consumes the crashed owner's
    // attempt — this is what bounds a poison task instead of looping forever.
    const owners = ["crash-1", "crash-2", "crash-3", "crash-4"];
    const seen: number[] = [];
    let t = T0;
    for (const owner of owners) {
      const claimed = s.manager.sql.claim(rec.id, owner, 60_000, t);
      expect(claimed.claimed).toBe(true);
      seen.push(claimed.task!.attempts);
      t += 60_001; // the previous owner's lease expires
    }
    // crash-1 claimed from pending (attempts stayed 0); crash-2/3/4 each
    // reclaimed a foreign expired lease → 1, 2, 3.
    expect(seen).toEqual([0, 1, 2, 3]);

    // The cap is reached: the worker's runOne cap-check settles failed with
    // the reclaim-cap error exactly as the live path does.
    const settled = s.manager.sql.settleRunning(rec.id, "crash-4", "failed", {
      attempts: 3,
      last_error: {
        name: "TaskReclaimCapError",
        message: "task consumed 3 attempts through lease reclaims (max 3)",
        code: "reclaim_cap",
      },
      next_attempt_at: null,
    });
    expect(settled.state).toBe("failed");
    expect(settled.last_error!.code).toBe("reclaim_cap");

    // Converged, not looping: the failed row is never a candidate again,
    // no matter how far the clock advances.
    expect(s.manager.sql.candidates(T0 + 10_000_000)).toEqual([]);
    const beyond = s.manager.sql.claim(rec.id, "crash-5", 60_000, T0 + 10_000_000);
    expect(beyond.claimed).toBe(false);
  });

  it("R2-6: retry() on a recurring task re-anchors next_attempt_at to the next cron fire, not now", async () => {
    const s = await makeStack();
    const rec = await s.manager.create(
      baseSpec({ schedule: "*/5 * * * *" }) as never,
      OWNER,
    );
    // Park it failed at 00:05 (the first fire).
    s.clock.now = T0 + 300_000;
    s.manager.sql.claim(rec.id, "w", 300_000, s.clock.now);
    s.manager.sql.settleRunning(rec.id, "w", "failed", {
      attempts: 3,
      last_error: { name: "Error", message: "parked failure" },
    });

    // 00:07 — retry() revives it. A one-shot would be due immediately; a
    // recurring task must wait for the NEXT fire (00:10), or the revive
    // double-fires inside the 00:05 window's schedule.
    s.clock.now = T0 + 420_000;
    await s.manager.retry(rec.id);
    const row = await s.manager.get(rec.id);
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(0);
    expect(row!.next_attempt_at).toBe(T0 + 600_000);

    // The re-anchor is enforced by the claim, not just recorded.
    expect(s.manager.sql.claim(rec.id, "w2", 300_000, s.clock.now).claimed).toBe(false);
    expect(s.manager.sql.claim(rec.id, "w2", 300_000, T0 + 600_000).claimed).toBe(true);
  });
});

describe("events", () => {
  it("pause/resume/cancel emit on the task's own log and the bound parent's log", async () => {
    const s = await makeStack();
    const parent = await s.store.create({ owner_id: "test-owner", persona_id: "p" });
    const rec = await s.manager.create(
      baseSpec({ parent_session_id: parent.session_id }) as never,
      OWNER,
    );
    await s.manager.pause(rec.id);
    await s.manager.resume(rec.id);
    await s.manager.cancel(rec.id);
    const own = await s.store.read(rec.task_session_id);
    const mirrored = await s.store.read(parent.session_id);
    const types = own.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["task.created", "task.paused", "task.resumed", "task.cancelled"]),
    );
    for (const t of ["task.created", "task.paused", "task.resumed", "task.cancelled"]) {
      expect(mirrored.some((e) => e.type === t && e.session_id === parent.session_id)).toBe(true);
    }
    for (const e of own) expect(e.session_id).toBe(rec.task_session_id);
  });
});
