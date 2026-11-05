// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.5 — the token-bucket rate limiter.
//
// Semantics (the brief's §1.5, made precise):
//   - Buckets are keyed (engagement id, rate class, target host). Different
//     hosts get different buckets.
//   - A tool declaring rate class "ffuf" charges rate_limits.ffuf; a tool
//     without a class charges the shared "default" bucket for its host.
//   - rate_limits.default is ALSO the per-host aggregate ceiling shared by
//     every REQUEST-rate tool on that host: ffuf (20 rps) and nuclei
//     (default 10 rps) against one host literally share the tighter default
//     bucket — the acceptance's "same host from two tools shares the
//     engagement's tighter rate". A per-tool entry looser than default is
//     therefore capped by the host aggregate; to give a tool headroom,
//     raise default. Packet-rate tools (nmap) count a different unit and
//     only charge their own class bucket.
//   - A tool that exceeds its limit BLOCKS until the bucket refills —
//     requests are never dropped (deliberate: dropping would make fuzzing
//     unreliable).
//   - The bucket starts EMPTY: even the first request waits one interval,
//     so the rate is strict with no burst allowance — 100 requests at
//     20 rps take exactly 5 s.
//
// Reservation model (GCRA-style): each bucket tracks when it may next fire;
// an acquire reserves the next slot on every applicable bucket and sleeps
// until the latest one. Concurrency-safe without queues by construction.

import type { Engagement } from "@nyx/protocol";
import { normalizeHost } from "@nyx/scope";

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Phase 6.1 (R1-10) — pluggable bucket persistence. Default: in-memory
   * (one process). Wire a SQLiteRateBucketStore over the shared nyx.db and
   * EVERY kernel process enforces the same buckets — two NYX processes on
   * one DB no longer run N× the declared rate.
   */
  store?: RateBucketStore;
}

/**
 * Persistence for GCRA bucket slots. The store is consulted synchronously
 * (better-sqlite3 is sync, so a transaction around get+set is trivially
 * atomic); the limiter sleeps OUTSIDE any store transaction — a reservation
 * commits immediately and the caller waits, so concurrent acquires (even
 * cross-process) serialize on the store and each get a distinct slot.
 */
export interface RateBucketStore {
  /** Reserve the next slot for `key` (see limiter key formats) and return
   *  the time it fires (Unix ms). MUST be atomic get+set. */
  reserve(key: string, interval_ms: number, now: number): number;
  /** Bookkeeping: how many buckets exist (diagnostics/tests). */
  bucketCount(): number;
}

/** One rate-limited acquisition. */
export interface RateTarget {
  engagement: Engagement;
  /** The tool's rate class, or null to charge the shared default bucket. */
  tool_class: string | null;
  host: string;
  unit: "requests" | "packets";
}

interface Bucket {
  /** When this bucket may next fire (Unix ms). */
  next_allowed_at: number;
  /** Refill interval in ms (1000 / rate). */
  interval_ms: number;
}

/** The default in-process store: the Phase 5 semantics, unchanged. */
class MemoryRateBucketStore implements RateBucketStore {
  private readonly buckets = new Map<string, Bucket>();
  reserve(key: string, interval_ms: number, now: number): number {
    const existing = this.buckets.get(key);
    const slot = existing === undefined ? now + interval_ms : Math.max(now, existing.next_allowed_at);
    this.buckets.set(key, { next_allowed_at: slot + interval_ms, interval_ms });
    return slot;
  }
  bucketCount(): number {
    return this.buckets.size;
  }
}

export class SecurityRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly store: RateBucketStore;

  constructor(deps: RateLimiterDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    this.store = deps.store ?? new MemoryRateBucketStore();
  }

  /** Bookkeeping only: how many buckets exist (diagnostics/tests). */
  get bucketCount(): number {
    return this.store.bucketCount();
  }

  /**
   * Block until every applicable bucket allows one more action. Resolves
   * immediately when the engagement declares no matching rate limits.
   */
  async acquire(t: RateTarget): Promise<void> {
    const limits = t.engagement.rate_limits ?? {};
    const own = t.tool_class === null ? undefined : limits[t.tool_class];

    // The tool's own class bucket — only when its entry declares this unit.
    const classRate =
      own === undefined
        ? undefined
        : t.unit === "requests"
          ? own.requests_per_second
          : own.packets_per_second;

    // The shared per-host default bucket — requests only, and only when the
    // engagement declares a default. An unclassed tool charges exactly this
    // bucket; a classed tool charges it in addition to its own.
    const hostRate =
      t.unit === "requests" ? limits.default?.requests_per_second : undefined;

    // The host is normalized (lowercased, one trailing dot stripped) so a
    // "example.com." spelling cannot split one host into two buckets (R1-4).
    const host = normalizeHost(t.host);
    const keys: Array<{ key: string; rate: number }> = [];
    if (classRate !== undefined) {
      keys.push({ key: `${t.engagement.id}|class:${t.tool_class}|${host}`, rate: classRate });
    }
    if (hostRate !== undefined) {
      keys.push({ key: `${t.engagement.id}|host:${host}`, rate: hostRate });
    }
    if (keys.length === 0) return;

    // GCRA reservation, Phase 6.1 form: every applicable bucket is reserved
    // ATOMICALLY in the store (memory: sequential; SQLite: one transaction)
    // and the caller sleeps until the LATEST reserved slot. The bucket still
    // starts empty — first request waits one interval, strict rate, no burst.
    const now = this.now();
    let waitMs = 0;
    for (const { key, rate } of keys) {
      const interval = 1000 / rate;
      const slot = this.store.reserve(key, interval, now);
      const wait = slot - now;
      if (wait > waitMs) waitMs = wait;
    }

    if (waitMs > 0) await this.sleep(Math.ceil(waitMs));
  }
}
