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

export class SecurityRateLimiter {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly buckets = new Map<string, Bucket>();

  constructor(deps: RateLimiterDeps = {}) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  }

  /** Bookkeeping only: how many buckets exist (diagnostics/tests). */
  get bucketCount(): number {
    return this.buckets.size;
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

    const now = this.now();
    let waitMs = 0;
    for (const { key, rate } of keys) {
      const interval = 1000 / rate;
      const existing = this.buckets.get(key);
      const bucket: Bucket =
        existing === undefined
          ? // Starts EMPTY: the first acquisition also waits one interval —
            // the strict rate with no free burst.
            { next_allowed_at: now + interval, interval_ms: interval }
          : existing;
      const slot = Math.max(now, bucket.next_allowed_at);
      bucket.next_allowed_at = slot + interval;
      this.buckets.set(key, bucket);
      const wait = slot - now;
      if (wait > waitMs) waitMs = wait;
    }

    if (waitMs > 0) await this.sleep(Math.ceil(waitMs));
  }
}
