// SPDX-License-Identifier: AGPL-3.0-or-later
// The lane queue: per-session FIFO execution. One session = one lane = serial
// execution by default; parallelism is an explicit configuration decision
// (per-session cap, or heartbeat tasks alongside interactive turns when
// opted out of serialization). A global concurrency cap with round-robin
// scheduling across lanes keeps a burst of sessions from starving each other.
//
// This is the serialization point that makes channel ingress (§1.2) and
// heartbeat turns (§1.3) safe: both enqueue into the session's lane and can
// never interleave their event streams.

export type LanePriority = "interactive" | "background" | "heartbeat";

export interface LaneTask<T> {
  session_id: string;
  priority: LanePriority;
  run: () => Promise<T>;
  /** Aborting this signal aborts the task (queued or running) and drains the rest of the session lane. */
  signal?: AbortSignal;
}

export interface LaneStatus {
  depth: number;
  running: boolean;
  head_priority: LanePriority | null;
}

export interface LaneQueue {
  /** Enqueue; resolves with the task's result, rejects on failure/abort/clear. */
  enqueue<T>(task: LaneTask<T>): Promise<T>;
  status(session_id: string): LaneStatus;
  /** Resolves when the session's queue is empty and nothing is running. */
  drain(session_id: string): Promise<void>;
  /** Aborts queued tasks (not the running one); the lane stays usable. */
  clear(session_id: string): void;
}

export interface LaneConfig {
  max_concurrent_global: number; // default 4
  max_concurrent_per_session: number; // default 1
  heartbeat_serialized_with_interactive: boolean; // default true
}

interface QueuedEntry {
  priority: LanePriority;
  start(): void;
  /** Remove from the queue and reject the task's promise. */
  abort(err: Error): void;
}

function abortError(reason: string): Error {
  const err = new Error(reason);
  err.name = "AbortError";
  return err;
}

/** Tasks that occupy the session's serial ("main") slots. */
function isMainClass(priority: LanePriority, heartbeatSerialized: boolean): boolean {
  return priority !== "heartbeat" || heartbeatSerialized;
}

class SessionLane {
  readonly queued: QueuedEntry[] = [];
  /** Main-slot task markers (interactive/background, and heartbeat when serialized). */
  readonly runningMain: object[] = [];
  /** Heartbeat task markers in the parallel slot (serialization opted out). */
  readonly runningHeartbeat: object[] = [];
  readonly drainWaiters: Array<() => void> = [];
  /** True while drainLane() is aborting the queue — suppresses starting. */
  draining = false;

  get isIdle(): boolean {
    return this.runningMain.length === 0 && this.runningHeartbeat.length === 0;
  }

  get isEmpty(): boolean {
    return this.queued.length === 0 && this.isIdle;
  }
}

export class LaneQueueImpl implements LaneQueue {
  private readonly lanes = new Map<string, SessionLane>();
  /** Round-robin rotation over lane ids (the head of the array is next). */
  private readonly rrOrder: string[] = [];
  private readonly cfg: Required<LaneConfig>;

  constructor(config: Partial<LaneConfig> = {}) {
    this.cfg = {
      max_concurrent_global: Math.max(1, config.max_concurrent_global ?? 4),
      max_concurrent_per_session: Math.max(1, config.max_concurrent_per_session ?? 1),
      heartbeat_serialized_with_interactive:
        config.heartbeat_serialized_with_interactive ?? true,
    };
  }

  enqueue<T>(task: LaneTask<T>): Promise<T> {
    const session_id = task.session_id;
    const lane = this.laneFor(session_id);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finishResolve = (value: T): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finishReject = (err: unknown): void => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const entry: QueuedEntry = {
        priority: task.priority,
        start: () => {
          const idx = lane.queued.indexOf(entry);
          if (idx >= 0) lane.queued.splice(idx, 1);
          const slot =
            isMainClass(task.priority, this.cfg.heartbeat_serialized_with_interactive)
              ? lane.runningMain
              : lane.runningHeartbeat;
          // Identity marker: removal is by reference, never by a colliding
          // position number.
          const marker = {};
          slot.push(marker);

          // Aborting a RUNNING task cancels it and drains the rest of the
          // session lane (§3.2 abort propagation); other sessions untouched.
          const onAbort = (): void => {
            if (settled) return; // finished normally already — a late abort is a no-op
            const t = slot.indexOf(marker);
            if (t >= 0) slot.splice(t, 1);
            finishReject(abortError(`lane task aborted (${session_id})`));
            this.drainLane(lane, `lane drained after abort (${session_id})`);
            this.schedule();
            this.notifyDrain(lane);
          };
          if (task.signal !== undefined) {
            if (task.signal.aborted) {
              onAbort();
              return;
            }
            task.signal.addEventListener("abort", onAbort, { once: true });
          }

          Promise.resolve()
            .then(() => task.run())
            .then(
              (value) => {
                const t = slot.indexOf(marker);
                if (t >= 0) slot.splice(t, 1);
                finishResolve(value);
                this.schedule();
                this.notifyDrain(lane);
              },
              (err) => {
                const t = slot.indexOf(marker);
                if (t >= 0) slot.splice(t, 1);
                finishReject(err);
                this.schedule();
                this.notifyDrain(lane);
              },
            );
        },
        abort: (err) => {
          const idx = lane.queued.indexOf(entry);
          if (idx < 0) return; // already started — aborting a running task goes through onAbort
          lane.queued.splice(idx, 1);
          finishReject(err);
          // During a drain, no new task of this lane may start — the drain
          // loop aborts the rest and the drainer schedules once at the end.
          if (!lane.draining) {
            this.schedule();
            this.notifyDrain(lane);
          }
        },
      };

      lane.queued.push(entry);
      if (!this.rrOrder.includes(session_id)) this.rrOrder.push(session_id);

      // Queued-phase abort: remove this task quietly (a queued abort does
      // NOT drain the lane — only a running task's abort does, per §3.2).
      if (task.signal !== undefined) {
        if (task.signal.aborted) {
          entry.abort(abortError(`lane task aborted before start (${session_id})`));
          return;
        }
        task.signal.addEventListener(
          "abort",
          () => {
            if (lane.queued.includes(entry)) {
              entry.abort(abortError(`lane task aborted while queued (${session_id})`));
            }
          },
          { once: true },
        );
      }

      this.schedule();
    });
  }

  status(session_id: string): LaneStatus {
    const lane = this.lanes.get(session_id);
    if (lane === undefined) {
      return { depth: 0, running: false, head_priority: null };
    }
    return {
      depth: lane.queued.length,
      running: !lane.isIdle,
      head_priority: lane.queued[0]?.priority ?? null,
    };
  }

  async drain(session_id: string): Promise<void> {
    const lane = this.laneFor(session_id);
    if (lane.isEmpty) return;
    await new Promise<void>((resolve) => {
      lane.drainWaiters.push(resolve);
      if (lane.isEmpty) resolve();
    });
  }

  clear(session_id: string): void {
    const lane = this.lanes.get(session_id);
    if (lane === undefined) return;
    this.drainLane(lane, `lane cleared (${session_id})`);
    this.schedule();
    this.notifyDrain(lane);
  }

  // ---- internals ---------------------------------------------------------

  private laneFor(session_id: string): SessionLane {
    let lane = this.lanes.get(session_id);
    if (lane === undefined) {
      lane = new SessionLane();
      this.lanes.set(session_id, lane);
    }
    return lane;
  }

  private drainLane(lane: SessionLane, reason: string): void {
    const err = abortError(reason);
    // abort() removes the entry from the queue itself (its settled-guard
    // keys off queue membership); loop until the queue is empty. While
    // draining, the lane's abort path suppresses scheduling so no queued
    // task can slip into the freed slot mid-drain.
    lane.draining = true;
    try {
      while (lane.queued.length > 0) {
        lane.queued[0]!.abort(err);
      }
    } finally {
      lane.draining = false;
    }
  }

  private notifyDrain(lane: SessionLane): void {
    if (lane.isEmpty) {
      for (const w of lane.drainWaiters.splice(0)) w();
    }
  }

  /**
   * The first startable entry for a lane, respecting FIFO within each class:
   * main-class entries run strictly in queue order when a main slot is free;
   * a heartbeat entry with serialization opted out may run in its own
   * parallel slot regardless of position.
   */
  private pickStartable(lane: SessionLane): QueuedEntry | undefined {
    const hbParallel = !this.cfg.heartbeat_serialized_with_interactive;
    if (hbParallel) {
      const hb = lane.queued.find((e) => e.priority === "heartbeat");
      if (hb !== undefined && lane.runningHeartbeat.length < 1) return hb;
    }
    const main = lane.queued.find((e) => isMainClass(e.priority, this.cfg.heartbeat_serialized_with_interactive));
    if (main !== undefined && lane.runningMain.length < this.cfg.max_concurrent_per_session) {
      return main;
    }
    return undefined;
  }

  private runningTotal(): number {
    let total = 0;
    for (const lane of this.lanes.values()) {
      total += lane.runningMain.length + lane.runningHeartbeat.length;
    }
    return total;
  }

  /** Round-robin scheduling pass: start what the caps allow, one task per lane per pass. */
  private schedule(): void {
    for (;;) {
      if (this.runningTotal() >= this.cfg.max_concurrent_global) return;
      const nextId = this.rrOrder.find((id) => {
        const lane = this.lanes.get(id);
        return lane !== undefined && this.pickStartable(lane) !== undefined;
      });
      if (nextId === undefined) {
        this.pruneIdleLanes();
        return;
      }
      const lane = this.lanes.get(nextId)!;
      const entry = this.pickStartable(lane)!;
      entry.start();
      // Rotate: one start per lane per pass — a session that has run 100
      // tasks gets no scheduling priority over one that has run 1.
      const idx = this.rrOrder.indexOf(nextId);
      if (idx >= 0) {
        this.rrOrder.splice(idx, 1);
        this.rrOrder.push(nextId);
      }
    }
  }

  private pruneIdleLanes(): void {
    for (const [id, lane] of this.lanes) {
      if (lane.isEmpty && lane.drainWaiters.length === 0) {
        this.lanes.delete(id);
        const idx = this.rrOrder.indexOf(id);
        if (idx >= 0) this.rrOrder.splice(idx, 1);
      }
    }
  }
}

export function createLaneQueue(config: Partial<LaneConfig> = {}): LaneQueue {
  return new LaneQueueImpl(config);
}
