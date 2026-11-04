// SPDX-License-Identifier: AGPL-3.0-or-later
// Heartbeat scheduler acceptance tests (§5.4): fires on schedule against a
// mock clock; missed fires (clock jump while down) are logged, never fired
// retroactively; trigger() fires on demand; restart does not double-fire;
// disabled specs never fire.
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { HeartbeatScheduler, HeartbeatStore } from "./heartbeat.js";
import type { HeartbeatFireSink, HeartbeatSpec } from "./heartbeat.js";

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

/** Every minute — easy to force with small clock advances. */
const EVERY_MINUTE = "* * * * *";

function spec(overrides: Partial<HeartbeatSpec> = {}): HeartbeatSpec {
  return {
    id: "hb-test",
    schedule: EVERY_MINUTE,
    prompt: "review everything",
    priority: "heartbeat",
    enabled: true,
    ...overrides,
  };
}

function makeScheduler(opts: {
  specs?: HeartbeatSpec[];
  now?: number;
  fired?: Array<{ spec_id: string; scheduledFor: number }>;
}) {
  const store = new HeartbeatStore(freshDb());
  const fired = opts.fired ?? [];
  const sink: HeartbeatFireSink = {
    fire: async (s, scheduledFor) => {
      fired.push({ spec_id: s.id, scheduledFor });
    },
  };
  let clock = opts.now ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  const scheduler = new HeartbeatScheduler({
    specs: opts.specs ?? [spec()],
    store,
    sink,
    now: () => clock,
    pollIntervalMs: 3_600_000, // tests drive poll() manually
  });
  return {
    scheduler,
    store,
    fired,
    advance: (ms: number): void => {
      clock += ms;
    },
    setClock: (ms: number): void => {
      clock = ms;
    },
    clock: () => clock,
  };
}

describe("HeartbeatScheduler", () => {
  it("fires on schedule against a mock clock and advances next_fire", async () => {
    const h = makeScheduler({});
    await h.scheduler.start();
    expect(h.fired).toEqual([]); // nothing due yet

    h.advance(60_001); // one minute past the first fire
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.spec_id).toBe("hb-test");
    expect(h.fired[0]!.scheduledFor).toBe(Date.UTC(2026, 0, 1, 0, 1));

    // The next fire is scheduled a minute later; poll before it is a no-op.
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(1);
    h.advance(60_000);
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.scheduledFor).toBe(Date.UTC(2026, 0, 1, 0, 2));

    const history = h.store.history();
    expect(history.filter((r) => r.status === "fired" && r.source === "schedule")).toHaveLength(2);
    await h.scheduler.stop();
  });

  it("a missed fire (clock jump while down) is logged as missed and not fired retroactively", async () => {
    const h = makeScheduler({});
    await h.scheduler.start();
    await h.scheduler.stop();

    // Simulate the process being down across the scheduled time: jump the
    // clock far past the persisted next_fire_at, then restart.
    h.advance(3_600_000);
    await h.scheduler.start();
    expect(h.fired).toEqual([]); // never fired retroactively
    const missed = h.store.history().filter((r) => r.status === "missed");
    expect(missed).toHaveLength(1);
    expect(missed[0]!.fired_at).toBe(Date.UTC(2026, 0, 1, 0, 1)); // the missed instant

    // The schedule resumes from now.
    h.advance(60_001);
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.scheduledFor).toBeGreaterThan(h.clock() - 61_000);
    await h.scheduler.stop();
  });

  it("restart does not double-fire a heartbeat that already ran", async () => {
    const h = makeScheduler({});
    await h.scheduler.start();
    h.advance(60_001);
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(1);

    // Restart on the same state: the already-fired slot must not repeat.
    await h.scheduler.stop();
    await h.scheduler.start();
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(1);

    // And after the next minute, exactly one more fire.
    h.advance(60_000);
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(2);
    await h.scheduler.stop();
  });

  it("trigger() fires on demand without consuming the schedule", async () => {
    const h = makeScheduler({});
    await h.scheduler.start();
    await h.scheduler.trigger("hb-test");
    expect(h.fired).toHaveLength(1);
    expect(h.fired[0]!.scheduledFor).toBe(h.clock()); // manual: fired "now"
    expect(h.store.history().some((r) => r.source === "manual")).toBe(true);

    // The scheduled fire still happens at its own time.
    h.advance(60_001);
    await h.scheduler.poll();
    expect(h.fired).toHaveLength(2);
    expect(h.fired[1]!.scheduledFor).toBe(Date.UTC(2026, 0, 1, 0, 1));
    await h.scheduler.stop();
  });

  it("disabled specs never fire; unknown trigger ids throw", async () => {
    const h = makeScheduler({ specs: [spec({ id: "off", enabled: false })] });
    await h.scheduler.start();
    h.advance(10 * 60_000);
    await h.scheduler.poll();
    expect(h.fired).toEqual([]);
    await expect(h.scheduler.trigger("does-not-exist")).rejects.toThrow(/unknown heartbeat spec/);
    // Disabled specs can still be triggered manually (operator's choice).
    await h.scheduler.trigger("off");
    expect(h.fired).toHaveLength(1);
    await h.scheduler.stop();
  });

  it("register/unregister/list manage the spec set; invalid cron is a hard error", () => {
    const h = makeScheduler({});
    h.scheduler.register(spec({ id: "extra", schedule: "0 3 * * *" }));
    expect(h.scheduler.list().map((s) => s.id).sort()).toEqual(["extra", "hb-test"]);
    h.scheduler.unregister("extra");
    expect(h.scheduler.list().map((s) => s.id)).toEqual(["hb-test"]);
    expect(() => h.scheduler.register(spec({ schedule: "not cron" }))).toThrow(/5 fields/);
  });
});

describe("HeartbeatScheduler timezone (2.0.3)", () => {
  it("a spec with timezone Asia/Karachi schedules 03:00 PKT, not 03:00 UTC", async () => {
    const fired: Array<{ spec_id: string; scheduledFor: number }> = [];
    const { scheduler, store } = makeScheduler({
      specs: [
        spec({
          id: "hb-pkt",
          schedule: "0 3 * * *",
          timezone: "Asia/Karachi",
        }),
      ],
      now: Date.UTC(2026, 10, 4, 10, 0), // 2026-11-04 10:00 UTC
      fired,
    });
    await scheduler.start();
    // Next fire: 2026-11-04 22:00 UTC = Nov 5, 03:00 PKT (UTC+5, no DST).
    expect(store.state("hb-pkt")?.next_fire_at).toBe(Date.UTC(2026, 10, 4, 22, 0));
    await scheduler.stop();
  });

  it("default UTC behavior is unchanged when no timezone is given", async () => {
    const { scheduler, store } = makeScheduler({
      specs: [spec({ id: "hb-utc", schedule: "0 3 * * *" })],
      now: Date.UTC(2026, 10, 4, 10, 0),
    });
    await scheduler.start();
    expect(store.state("hb-utc")?.next_fire_at).toBe(Date.UTC(2026, 10, 5, 3, 0));
    await scheduler.stop();
  });

  it("registering a spec with an unknown timezone is a hard error", () => {
    expect(() =>
      new HeartbeatScheduler({
        specs: [spec({ id: "hb-bad", timezone: "Mars/Olympus" })],
        store: new HeartbeatStore(freshDb()),
        sink: { fire: () => undefined },
      }),
    ).toThrow(/unknown IANA timezone/);
  });

  it("a zoned spec fires when the wall clock reaches the local time", async () => {
    const fired: Array<{ spec_id: string; scheduledFor: number }> = [];
    const { scheduler, advance } = makeScheduler({
      specs: [spec({ id: "hb-pkt2", schedule: "30 9 * * *", timezone: "Asia/Karachi" })],
      now: Date.UTC(2026, 0, 1, 0, 0), // 05:00 PKT Jan 1
      fired,
    });
    await scheduler.start();
    // Next fire: Jan 1, 09:30 PKT = 04:30 UTC.
    await advance(4 * 3_600_000 + 30 * 60_000); // to exactly 04:30 UTC
    // poll happens on advance in these tests? No — poll() is manual here:
    await scheduler.poll();
    expect(fired).toEqual([{ spec_id: "hb-pkt2", scheduledFor: Date.UTC(2026, 0, 1, 4, 30) }]);
    await scheduler.stop();
  });
});
