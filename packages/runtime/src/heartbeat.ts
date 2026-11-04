// SPDX-License-Identifier: AGPL-3.0-or-later
// The heartbeat scheduler: cron-driven system turns (memory review, task
// resumption, periodic summaries). On fire, a turn is enqueued at `heartbeat`
// priority into the target session's lane — the same serialization point the
// HTTP API and channels use. State (last/next fire per spec) persists in
// SQLite so a restart neither re-fires what already ran nor fires what was
// missed while the process was down: missed fires are logged as
// heartbeat.missed history rows, never fired retroactively.

import type { Logger } from "@nyx/protocol";
import type Database from "better-sqlite3";
import { nextFire, parseCron } from "./cron.js";
import type { CronSchedule } from "./cron.js";

export interface HeartbeatSpec {
  id: string;
  /** 5-field cron expression (minute hour dom month dow, UTC). */
  schedule: string;
  /** Default: the session's persona / the configured default persona. */
  persona_id?: string;
  /** Default: a new session per fire. */
  session_id?: string;
  /** The user message of the system-generated turn. */
  prompt: string;
  priority: "heartbeat";
  enabled: boolean;
}

/** What the host does when a heartbeat fires (enqueue the turn). */
export interface HeartbeatFireSink {
  fire(spec: HeartbeatSpec, scheduledFor: number): Promise<void> | void;
}

export interface Scheduler {
  register(spec: HeartbeatSpec): void;
  unregister(id: string): void;
  list(): HeartbeatSpec[];
  /** Manual fire, useful for tests and operator runs. */
  trigger(id: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One scheduling pass; the interval timer calls it, tests call it directly. */
  poll(): Promise<void>;
}

export interface HeartbeatSchedulerOptions {
  specs?: HeartbeatSpec[];
  store: HeartbeatStore;
  sink: HeartbeatFireSink;
  now?: () => number;
  pollIntervalMs?: number;
  logger?: Logger;
}

const DDL = `
CREATE TABLE IF NOT EXISTS heartbeat_state (
  spec_id TEXT PRIMARY KEY,
  last_fired_at INTEGER,
  next_fire_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS heartbeat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spec_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  source TEXT NOT NULL
)`;

export class HeartbeatStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    db.exec(DDL);
    this.db = db;
  }

  state(spec_id: string): { last_fired_at: number | null; next_fire_at: number } | null {
    const row = this.db
      .prepare("SELECT last_fired_at, next_fire_at FROM heartbeat_state WHERE spec_id = ?")
      .get(spec_id) as { last_fired_at: number | null; next_fire_at: number } | undefined;
    return row ?? null;
  }

  saveState(spec_id: string, last_fired_at: number | null, next_fire_at: number): void {
    this.db
      .prepare(
        `INSERT INTO heartbeat_state (spec_id, last_fired_at, next_fire_at) VALUES (?, ?, ?)
         ON CONFLICT(spec_id) DO UPDATE SET last_fired_at = excluded.last_fired_at, next_fire_at = excluded.next_fire_at`,
      )
      .run(spec_id, last_fired_at, next_fire_at);
  }

  record(spec_id: string, fired_at: number, status: "fired" | "missed", source: "schedule" | "manual" | "missed"): void {
    this.db
      .prepare(
        "INSERT INTO heartbeat_history (spec_id, fired_at, status, source) VALUES (?, ?, ?, ?)",
      )
      .run(spec_id, fired_at, status, source);
  }

  history(spec_id?: string): Array<{ spec_id: string; fired_at: number; status: string; source: string }> {
    const sql = spec_id === undefined
      ? "SELECT spec_id, fired_at, status, source FROM heartbeat_history ORDER BY id"
      : "SELECT spec_id, fired_at, status, source FROM heartbeat_history WHERE spec_id = ? ORDER BY id";
    return (spec_id === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(spec_id)) as Array<{
      spec_id: string;
      fired_at: number;
      status: string;
      source: string;
    }>;
  }

  close(): void {
    this.db.close();
  }
}

export class HeartbeatScheduler implements Scheduler {
  private readonly specs = new Map<string, HeartbeatSpec>();
  private readonly schedules = new Map<string, CronSchedule>();
  private readonly store: HeartbeatStore;
  private readonly sink: HeartbeatFireSink;
  private readonly now: () => number;
  private readonly log: Logger | undefined;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: HeartbeatSchedulerOptions) {
    for (const spec of opts.specs ?? []) this.register(spec);
    this.store = opts.store;
    this.sink = opts.sink;
    this.now = opts.now ?? Date.now;
    this.log = opts.logger;
    this.pollIntervalMs = opts.pollIntervalMs ?? 30_000;
  }

  register(spec: HeartbeatSpec): void {
    const schedule = parseCron(spec.schedule); // invalid specs are a hard error
    this.specs.set(spec.id, spec);
    this.schedules.set(spec.id, schedule);
  }

  unregister(id: string): void {
    this.specs.delete(id);
    this.schedules.delete(id);
  }

  list(): HeartbeatSpec[] {
    return [...this.specs.values()].map((s) => ({ ...s }));
  }

  async start(): Promise<void> {
    if (this.timer !== undefined) return;
    const now = this.now();
    for (const spec of this.specs.values()) {
      if (!spec.enabled) continue;
      const state = this.store.state(spec.id);
      if (state === null) {
        this.store.saveState(spec.id, null, nextFire(this.schedules.get(spec.id)!, now));
        continue;
      }
      if (state.next_fire_at <= now) {
        // The scheduled time passed while the process was down: log it as
        // missed, never fire retroactively, and reschedule from now.
        this.store.record(spec.id, state.next_fire_at, "missed", "missed");
        this.log?.warn("heartbeat.missed", {
          spec_id: spec.id,
          scheduled_for: new Date(state.next_fire_at).toISOString(),
        });
        this.store.saveState(
          spec.id,
          state.last_fired_at,
          nextFire(this.schedules.get(spec.id)!, now),
        );
      }
    }
    this.timer = setInterval(() => {
      void this.poll().catch((err: unknown) => {
        this.log?.error("heartbeat.poll_failed", { error: String(err) });
      });
    }, this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async poll(): Promise<void> {
    const now = this.now();
    for (const spec of this.specs.values()) {
      if (!spec.enabled) continue;
      const state = this.store.state(spec.id);
      if (state === null) {
        this.store.saveState(spec.id, null, nextFire(this.schedules.get(spec.id)!, now));
        continue;
      }
      if (state.next_fire_at > now) continue;
      // Advance the state BEFORE firing: a crash mid-fire must not re-fire.
      const scheduledFor = state.next_fire_at;
      this.store.saveState(
        spec.id,
        scheduledFor,
        nextFire(this.schedules.get(spec.id)!, scheduledFor),
      );
      this.store.record(spec.id, scheduledFor, "fired", "schedule");
      this.log?.info("heartbeat.fired", {
        spec_id: spec.id,
        scheduled_for: new Date(scheduledFor).toISOString(),
      });
      await this.sink.fire(spec, scheduledFor);
    }
  }

  async trigger(id: string): Promise<void> {
    const spec = this.specs.get(id);
    if (spec === undefined) throw new Error(`unknown heartbeat spec "${id}"`);
    const now = this.now();
    // Manual fires are recorded but do not consume the schedule.
    this.store.record(spec.id, now, "fired", "manual");
    this.log?.info("heartbeat.triggered", { spec_id: id });
    await this.sink.fire(spec, now);
  }
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): Scheduler {
  return new HeartbeatScheduler(opts);
}
