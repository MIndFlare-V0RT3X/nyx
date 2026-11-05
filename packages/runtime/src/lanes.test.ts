// SPDX-License-Identifier: AGPL-3.0-or-later
// Acceptance tests for the lane queue (§3.4): FIFO per session, serial
// per-session execution, global cap under simultaneous sessions, abort
// propagation, drain/clear semantics, and the heartbeat serialization flag.
import { describe, expect, it } from "vitest";
import { createLaneQueue } from "./lanes.js";
import type { LanePriority } from "./lanes.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(err: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function task<T>(
  session_id: string,
  priority: LanePriority,
  run: () => Promise<T>,
  signal?: AbortSignal,
) {
  return { session_id, priority, run, ...(signal !== undefined ? { signal } : {}) };
}

describe("LaneQueueImpl", () => {
  it("100 turns enqueued to one session execute in FIFO order", async () => {
    const lanes = createLaneQueue();
    const order: number[] = [];
    const jobs = Array.from({ length: 100 }, (_, i) =>
      lanes.enqueue(
        task("s1", "interactive", async () => {
          order.push(i);
          return i;
        }),
      ),
    );
    const results = await Promise.all(jobs);
    expect(results).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i)); // strictly 0..99
    expect(lanes.status("s1")).toEqual({ depth: 0, running: false, head_priority: null });
  });

  it("two sessions running concurrently never interleave within a session (per-session seq stays monotonic)", async () => {
    const lanes = createLaneQueue({ max_concurrent_global: 4 });
    const perSession: Record<string, number[]> = { A: [], B: [] };
    const perSessionConcurrent: Record<string, number> = { A: 0, B: 0 };
    const peak: Record<string, number> = { A: 0, B: 0 };

    const job = (sid: "A" | "B", i: number) =>
      lanes.enqueue(
        task(sid, "interactive", async () => {
          perSessionConcurrent[sid] = (perSessionConcurrent[sid] ?? 0) + 1;
          peak[sid] = Math.max(peak[sid] ?? 0, perSessionConcurrent[sid] ?? 0);
          await sleep(2); // plenty of cross-session interleaving opportunities
          (perSession[sid] ??= []).push(i);
          perSessionConcurrent[sid] = (perSessionConcurrent[sid] ?? 0) - 1;
        }),
      );

    // Interleave the enqueueing so cross-session ordering is genuinely mixed.
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 25; i++) {
      jobs.push(job("A", i));
      jobs.push(job("B", i));
    }
    await Promise.all(jobs);

    expect(perSession.A).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(perSession.B).toEqual(Array.from({ length: 25 }, (_, i) => i));
    // Serial per session — never two tasks of one session at the same time.
    expect(peak.A).toBe(1);
    expect(peak.B).toBe(1);
  });

  it("max_concurrent_per_session: 1 — turn 2 does not start until turn 1 finishes (slow mock tool)", async () => {
    const lanes = createLaneQueue();
    const gate = deferred<void>();
    const started: number[] = [];

    const first = lanes.enqueue(
      task("s", "interactive", async () => {
        started.push(1);
        await gate.promise; // slow tool: holds the lane
        return "first";
      }),
    );
    const second = lanes.enqueue(
      task("s", "interactive", async () => {
        started.push(2);
        return "second";
      }),
    );
    await sleep(10);
    expect(started).toEqual([1]);
    expect(lanes.status("s")).toEqual({ depth: 1, running: true, head_priority: "interactive" });

    gate.resolve();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(started).toEqual([1, 2]);
  });

  it("aborting a running turn cancels it and drains the session queue; other sessions are untouched", async () => {
    const lanes = createLaneQueue({ max_concurrent_global: 4 });
    const ac = new AbortController();
    const gate = deferred<void>();
    const started: string[] = [];

    const running = lanes.enqueue(
      task(
        "victim",
        "interactive",
        () => {
          started.push("victim-1");
          return gate.promise.then(() => "never"); // ignores the signal on purpose
        },
        ac.signal,
      ),
    );
    const queued2 = lanes.enqueue(
      task("victim", "interactive", async () => {
        started.push("victim-2");
      }),
    );
    const queued3 = lanes.enqueue(
      task("victim", "interactive", async () => {
        started.push("victim-3");
      }),
    );
    const bystander = lanes.enqueue(
      task("other", "interactive", async () => {
        started.push("other-1");
        await sleep(5);
      }),
    );

    await sleep(10);
    expect(started).toContain("victim-1");
    expect(started).toContain("other-1");
    expect(started).not.toContain("victim-2");

    ac.abort(); // cancel the running turn

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued2).rejects.toMatchObject({ name: "AbortError" });
    await expect(queued3).rejects.toMatchObject({ name: "AbortError" });
    await expect(bystander).resolves.toBeUndefined(); // unaffected
    expect(started).not.toContain("victim-2");
    expect(started).not.toContain("victim-3");
    await lanes.drain("other");
    expect(lanes.status("victim")).toEqual({ depth: 0, running: false, head_priority: null });
  });

  it("a queued task whose signal aborts is removed quietly (the lane keeps going)", async () => {
    const lanes = createLaneQueue();
    const gate = deferred<void>();
    const ac = new AbortController();
    const started: number[] = [];

    const first = lanes.enqueue(
      task("s", "interactive", async () => {
        started.push(1);
        await gate.promise;
      }),
    );
    const doomed = lanes.enqueue(
      task(
        "s",
        "interactive",
        async () => {
          started.push(2);
        },
        ac.signal,
      ),
    );
    const third = lanes.enqueue(
      task("s", "interactive", async () => {
        started.push(3);
      }),
    );

    await sleep(5);
    ac.abort();
    await expect(doomed).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    await Promise.all([first, third]);
    expect(started).toEqual([1, 3]);
  });

  it("global concurrency cap holds under 20 sessions submitted simultaneously", async () => {
    const CAP = 4;
    const lanes = createLaneQueue({ max_concurrent_global: CAP });
    let live = 0;
    let peak = 0;
    const completed: string[] = [];

    const jobs = Array.from({ length: 20 }, (_, i) => {
      const sid = `s${i}`;
      return lanes.enqueue(
        task(sid, "interactive", async () => {
          live += 1;
          peak = Math.max(peak, live);
          await sleep(5);
          live -= 1;
          completed.push(sid);
        }),
      );
    });
    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(CAP);
    expect(peak).toBeGreaterThan(1); // it really did run concurrently
    expect(completed).toHaveLength(20);
    expect(new Set(completed).size).toBe(20);
  });

  it("round-robin: a busy session does not starve a fresh one", async () => {
    const lanes = createLaneQueue({ max_concurrent_global: 2 });
    const order: string[] = [];
    const job = (sid: string) =>
      lanes.enqueue(
        task(sid, "interactive", async () => {
          order.push(sid);
          await sleep(3);
        }),
      );

    // Session A floods the queue first, then B arrives with one task.
    const jobs: Array<Promise<void>> = [];
    for (let i = 0; i < 6; i++) jobs.push(job("A"));
    jobs.push(job("B"));
    await Promise.all(jobs);
    // B finishes within the first two completions — not last.
    expect(order.indexOf("B")).toBeLessThan(2);
  });

  it("heartbeat serialized with interactive by default; parallel when the flag is false", async () => {
    // Default: serialized — the heartbeat waits for the interactive turn.
    const serialized = createLaneQueue();
    const gate = deferred<void>();
    const startOrder: string[] = [];
    const interactive = serialized.enqueue(
      task("s", "interactive", async () => {
        startOrder.push("interactive");
        await gate.promise;
      }),
    );
    const hb = serialized.enqueue(
      task("s", "heartbeat", async () => {
        startOrder.push("heartbeat");
      }),
    );
    await sleep(5);
    expect(startOrder).toEqual(["interactive"]); // heartbeat is waiting
    gate.resolve();
    await Promise.all([interactive, hb]);
    expect(startOrder).toEqual(["interactive", "heartbeat"]);

    // Opted out: the heartbeat runs alongside the interactive turn.
    const parallel = createLaneQueue({ heartbeat_serialized_with_interactive: false });
    const gate2 = deferred<void>();
    const startOrder2: string[] = [];
    const interactive2 = parallel.enqueue(
      task("s", "interactive", async () => {
        startOrder2.push("interactive");
        await gate2.promise;
      }),
    );
    const hb2 = parallel.enqueue(
      task("s", "heartbeat", async () => {
        startOrder2.push("heartbeat");
      }),
    );
    await sleep(5);
    expect(startOrder2.sort()).toEqual(["heartbeat", "interactive"]); // both running
    gate2.resolve();
    await Promise.all([interactive2, hb2]);
  });

  it("drain waits for the queue to empty; clear aborts queued tasks but not the running one", async () => {
    const lanes = createLaneQueue();
    const gate = deferred<void>();
    const started: string[] = [];

    const first = lanes.enqueue(
      task("s", "interactive", async () => {
        started.push("first");
        await gate.promise;
        return "first-done";
      }),
    );
    const queued = lanes.enqueue(
      task("s", "background", async () => {
        started.push("queued");
      }),
    );
    await sleep(5);
    lanes.clear("s"); // running task survives
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve();
    expect(await first).toBe("first-done");
    await lanes.drain("s");
    expect(started).toEqual(["first"]);

    // drain() on an active lane resolves once everything lands.
    const gate3 = deferred<void>();
    const a = lanes.enqueue(
      task("s", "interactive", async () => {
        await gate3.promise;
      }),
    );
    const b = lanes.enqueue(task("s", "interactive", async () => undefined));
    let drained = false;
    const drainPromise = lanes.drain("s").then(() => {
      drained = true;
    });
    await sleep(5);
    expect(drained).toBe(false);
    gate3.resolve();
    await Promise.all([a, b]);
    await drainPromise;
    expect(drained).toBe(true);
  });
});
