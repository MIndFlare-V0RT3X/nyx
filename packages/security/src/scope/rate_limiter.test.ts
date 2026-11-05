// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { Engagement, EngagementRateLimits } from "@nyx/protocol";
import { SecurityRateLimiter } from "./rate_limiter.js";

const NOW = 1_700_000_000_000;

function engagement(rate_limits?: EngagementRateLimits): Engagement {
  return {
    id: "ENG-2026-042",
    operator_id: "owner",
    authorized_at: NOW - 60_000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: ["203.0.113.0/24"], domains: [] },
    ...(rate_limits !== undefined ? { rate_limits } : {}),
  };
}

/** A virtual clock: sleeping advances time; nothing else does. */
function virtualRig(): { limiter: SecurityRateLimiter; clock: { now: number } } {
  const clock = { now: NOW };
  const limiter = new SecurityRateLimiter({
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  return { limiter, clock };
}

describe("SecurityRateLimiter — the §1.5/§1.7 acceptance math (virtual clock)", () => {
  it("100 ffuf requests at 20 rps take ≥5 seconds wall time (strict, no burst)", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement({
      default: { requests_per_second: 50 },
      ffuf: { requests_per_second: 20 },
    });
    for (let i = 0; i < 100; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "ffuf",
        host: "app.example.com",
        unit: "requests",
      });
    }
    expect(clock.now - NOW).toBeGreaterThanOrEqual(5_000);
    expect(clock.now - NOW).toBeLessThan(5_100); // and not grossly more
  });

  it("cross-tool: ffuf and nuclei against one host share the tighter (default) bucket", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement({
      default: { requests_per_second: 10 },
      ffuf: { requests_per_second: 20 },
    });
    // Control first: ffuf ALONE at its own 20 rps would finish 10 requests
    // in 500 ms — but the shared default-10 host bucket holds it to 1000 ms.
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "ffuf",
        host: "app.example.com",
        unit: "requests",
      });
    }
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_000);

    // Now interleave nuclei (no class → the shared default bucket): 10 ffuf +
    // 10 nuclei on the same host must take ≥2 s through the shared bucket.
    const start = clock.now;
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "ffuf",
        host: "app.example.com",
        unit: "requests",
      });
      await limiter.acquire({
        engagement: eng,
        tool_class: null,
        host: "app.example.com",
        unit: "requests",
      });
    }
    expect(clock.now - start).toBeGreaterThanOrEqual(2_000);
  });

  it("different hosts get different buckets — parallel timelines, not one queue", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement({ default: { requests_per_second: 10 } });
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: null,
        host: "a.example.com",
        unit: "requests",
      });
      await limiter.acquire({
        engagement: eng,
        tool_class: null,
        host: "b.example.com",
        unit: "requests",
      });
    }
    // 10 requests per host at 10 rps = 1000 ms — NOT the 2000 ms a single
    // shared queue would impose.
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_000);
    expect(clock.now - NOW).toBeLessThan(1_900);
  });

  it("different engagements get different buckets for the same host", async () => {
    const { limiter, clock } = virtualRig();
    const a = engagement({ default: { requests_per_second: 10 } });
    const b: Engagement = {
      ...engagement({ default: { requests_per_second: 10 } }),
      id: "ENG-OTHER",
    };
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        engagement: a,
        tool_class: null,
        host: "app.example.com",
        unit: "requests",
      });
      await limiter.acquire({
        engagement: b,
        tool_class: null,
        host: "app.example.com",
        unit: "requests",
      });
    }
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_000);
    expect(clock.now - NOW).toBeLessThan(1_900);
    expect(limiter.bucketCount).toBe(2);
  });

  it("packet-rate tools charge their own class bucket and ignore request defaults", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement({
      default: { requests_per_second: 10 },
      nmap: { packets_per_second: 100 },
    });
    for (let i = 0; i < 100; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "nmap",
        host: "203.0.113.42",
        unit: "packets",
      });
    }
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_000);
    expect(clock.now - NOW).toBeLessThan(1_100);
  });

  it("no rate limits declared → acquire never blocks", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement();
    for (let i = 0; i < 1_000; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "ffuf",
        host: "app.example.com",
        unit: "requests",
      });
    }
    expect(clock.now).toBe(NOW);
    expect(limiter.bucketCount).toBe(0);
  });

  it("a classed tool whose entry lacks the unit falls back to the shared default bucket", async () => {
    const { limiter, clock } = virtualRig();
    const eng = engagement({
      default: { requests_per_second: 10 },
      nmap: { packets_per_second: 100 }, // declares packets, not requests
    });
    for (let i = 0; i < 10; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: "nmap",
        host: "h.example.com",
        unit: "requests",
      });
    }
    expect(clock.now - NOW).toBeGreaterThanOrEqual(1_000); // default rps applies
  });
});

describe("SecurityRateLimiter — real-clock smoke (the reservation sleeps for real)", () => {
  it("5 requests at 20 rps take ≥240 ms of real wall time", async () => {
    const limiter = new SecurityRateLimiter(); // real now + real setTimeout
    const eng = engagement({ default: { requests_per_second: 20 } });
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      await limiter.acquire({
        engagement: eng,
        tool_class: null,
        host: "app.example.com",
        unit: "requests",
      });
    }
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(240); // 5 × 50 ms = 250, timer slack allowed
  });
});
