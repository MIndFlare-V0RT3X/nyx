// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 (R1-10) — the SQLite rate-bucket store: two independent limiter
// instances (stand-ins for two kernel processes) over ONE nyx.db enforce the
// SAME slots — the aggregate rate holds, which is exactly the property the
// Phase 5 in-memory limiter could not provide.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fsp } from "node:fs";
import Database from "better-sqlite3";
import type { Engagement } from "@nyx/protocol";
import { SqliteRateBucketStore } from "./rate_store.js";
import { SecurityRateLimiter } from "./rate_limiter.js";

const NOW = 1_700_000_000_000;

function engagement(): Engagement {
  return {
    id: "ENG-RATE",
    operator_id: "owner",
    authorized_at: NOW - 1000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: ["203.0.113.0/24"], domains: [] },
    techniques: ["web_enumeration"],
    rate_limits: {
      default: { requests_per_second: 5 },
      sqlmap: { requests_per_second: 2 },
    },
  };
}

describe("SqliteRateBucketStore", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeAll(async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nyx-rate-store-"));
    dbPath = path.join(dir, "nyx.db");
    db = new Database(dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS rate_buckets (
         key TEXT PRIMARY KEY,
         next_allowed_at INTEGER NOT NULL,
         interval_ms INTEGER NOT NULL,
         updated_at INTEGER NOT NULL
       );
       CREATE INDEX IF NOT EXISTS idx_rate_buckets_updated ON rate_buckets(updated_at);`,
    );
  });

  afterAll(async () => {
    db.close();
    await fsp.rm(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("reserves sequential slots with the strict no-burst start", () => {
    const store = new SqliteRateBucketStore({ db, now: () => NOW });
    const interval = 200; // 5 rps
    const s1 = store.reserve("k", interval, NOW);
    expect(s1).toBe(NOW + interval); // first acquisition waits one interval
    const s2 = store.reserve("k", interval, NOW);
    expect(s2).toBe(NOW + 2 * interval);
    expect(store.bucketCount()).toBe(1);
  });

  it("R1-10 proof: two limiter instances over one db share one bucket — 6 acquires at 5 rps take >= 1s of reserved slots", async () => {
    // Two "processes": separate SecurityRateLimiter objects, same database.
    const a = new SecurityRateLimiter({
      store: new SqliteRateBucketStore({ db, now: () => NOW }),
      now: () => NOW,
      sleep: async () => undefined, // we measure the reserved slots, not sleep
    });
    const b = new SecurityRateLimiter({
      store: new SqliteRateBucketStore({ db, now: () => NOW }),
      now: () => NOW,
      sleep: async () => undefined,
    });
    const target = { host: "example.com" as const };
    // 6 interleaved acquires across the two "processes" on ONE host bucket.
    for (let i = 0; i < 6; i += 1) {
      const limiter = i % 2 === 0 ? a : b;
      await limiter.acquire({ engagement: engagement(), tool_class: null, ...target, unit: "requests" });
    }
    // The sleep is stubbed, but the SLOT the 6th acquire reserved must be
    // 6 intervals out (1.2 s at 5 rps): interleave two processes and the
    // aggregate rate is still the declared one.
    const row = db
      .prepare("SELECT next_allowed_at FROM rate_buckets WHERE key = ?")
      .get(`${engagement().id}|host:example.com`) as { next_allowed_at: number };
    expect(row.next_allowed_at).toBeGreaterThanOrEqual(NOW + 6 * 200);
  });

  it("class + host buckets: an sqlmap-class acquire charges both (the tightest class and the per-host aggregate)", async () => {
    const limiter = new SecurityRateLimiter({
      store: new SqliteRateBucketStore({ db, now: () => NOW }),
      now: () => NOW,
      sleep: async () => undefined,
    });
    await limiter.acquire({
      engagement: engagement(),
      tool_class: "sqlmap",
      host: "sql.example.com",
      unit: "requests",
    });
    const keys = (
      db
        .prepare("SELECT key FROM rate_buckets")
        .all() as Array<{ key: string }>
    ).map((r) => r.key);
    expect(keys).toContain(`${engagement().id}|class:sqlmap|sql.example.com`);
    expect(keys).toContain(`${engagement().id}|host:sql.example.com`);
  });

  it("stale rows are pruned by the lazy sweep", () => {
    const ancient = NOW - 4 * 60 * 60 * 1000; // beyond STALE_MS (3h)
    db.prepare(
      "INSERT OR REPLACE INTO rate_buckets (key, next_allowed_at, interval_ms, updated_at) VALUES (?, ?, ?, ?)",
    ).run("stale-key", ancient, 1000, ancient);
    const store = new SqliteRateBucketStore({ db, now: () => NOW + 120_000 });
    store.reserve("fresh-key", 1000, NOW + 120_000); // triggers the sweep
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM rate_buckets WHERE key = 'stale-key'")
      .get() as { n: number };
    expect(left.n).toBe(0);
  });
});
