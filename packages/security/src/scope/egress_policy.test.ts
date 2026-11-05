// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — the egress policy + binder tests (docs/EGRESS-PROXY.md).
//
// The proxy mechanics are tested in @nyx/sandbox (proxy.test.ts, with real
// sockets); THESE tests prove the DECISIONS: scope (window, inclusions,
// exclusions, ports), the rebinding pin, per-CONNECT rate charging with
// listener-attributed classes, exactly one audit row per decision, and the
// binder's port mapping + env + rollback.

import { afterAll, describe, expect, it } from "vitest";
import * as net from "node:net";
import type { Engagement } from "@nyx/protocol";
import type { EgressResolver, ResolvedEndpoint } from "@nyx/tools";
import type { ResolvedAddress } from "@nyx/scope";
import { EgressProxyServer } from "@nyx/sandbox";
import type { EgressDecision, EgressListenerContext, SandboxEgressBinding } from "@nyx/sandbox";
import { createEgressBinder, createEgressPolicy } from "./egress_policy.js";
import { SecurityRateLimiter } from "./rate_limiter.js";
import type { EngagementAuditSink } from "../engagement/loader.js";

const NOW = 1_700_000_000_000;

/** A resolver the test fully controls — including per-call rebinding. */
class FakeResolver implements EgressResolver {
  answers: ((hostname: string) => ResolvedAddress[]) | null = null;
  async resolve(hostname: string, port: number): Promise<ResolvedEndpoint> {
    if (this.answers === null) throw new Error("no answer configured");
    const ips = this.answers(hostname);
    if (ips.length === 0) throw new Error(`no addresses for ${hostname}`);
    return { hostname, port, ips, pinned_until: NOW + 30_000 };
  }
}

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "ENG-2026-061",
    operator_id: "owner",
    authorized_at: NOW - 60_000,
    expires_at: NOW + 3_600_000,
    targets: {
      cidrs: ["127.0.0.0/8", "203.0.113.0/24"],
      domains: ["example.com"],
      exclude: { cidrs: ["203.0.113.99/32"] },
    },
    techniques: ["web_enumeration"],
    rate_limits: {
      default: { requests_per_second: 10 },
      sqlmap: { requests_per_second: 2 },
    },
    ...overrides,
  };
}

interface AuditRow {
  actor: string;
  action: string;
  payload: {
    session_id: string;
    engagement_id: string;
    host: string;
    port: number;
    rate_class: string | null;
    decision: string;
    reason: string;
    matched?: string;
    pinned_ips?: string[];
  };
}

function sink(): { rows: AuditRow[]; audit: EngagementAuditSink } {
  const rows: AuditRow[] = [];
  return { rows, audit: (r) => rows.push(r as AuditRow) };
}

function context(overrides: Partial<EgressListenerContext> = {}): EgressListenerContext {
  return {
    session_id: "sess-1",
    sandbox_id: "sbx-1",
    engagement: engagement(),
    rate_class: null,
    ...overrides,
  };
}

describe("createEgressPolicy — the per-CONNECT decision", () => {
  it("in-scope hostname: allow, pin the resolved IP, one allowed audit row", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    const { rows, audit } = sink();
    const limiter = new SecurityRateLimiter({ now: () => NOW });
    const policy = createEgressPolicy({ resolver, limiter, audit, now: () => NOW });

    const decision: EgressDecision = await policy.decide(context(), {
      host: "example.com",
      port: 443,
    });
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") {
      expect(decision.pinned_ips).toEqual(["203.0.113.10"]);
    }
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.egress.allowed");
    expect(rows[0]!.payload.engagement_id).toBe("ENG-2026-061");
    expect(rows[0]!.payload.pinned_ips).toEqual(["203.0.113.10"]);
  });

  it("out-of-scope hostname: deny with one denied audit row", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    const { rows, audit } = sink();
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      audit,
      now: () => NOW,
    });
    const decision = await policy.decide(context(), { host: "notauthorized.net", port: 443 });
    expect(decision.decision).toBe("deny");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.egress.denied");
    expect(rows[0]!.payload.decision).toBe("deny");
  });

  it("exclusions always win — a resolved IP inside an excluded CIDR denies", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.99", family: 4 }]; // excluded /32
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      now: () => NOW,
    });
    const decision = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(decision.decision).toBe("deny");
  });

  it("IP literal: the CIDR check applies without resolution", async () => {
    const resolver = new FakeResolver();
    // If the policy consulted the resolver for an IP literal, this throws and
    // the decision degrades to a resolution-failure deny — the allow below
    // would fail. That is the tripwire.
    resolver.answers = () => {
      throw new Error("resolver must not be consulted for IP literals");
    };
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      now: () => NOW,
    });
    const inCidr = await policy.decide(context(), { host: "127.0.0.1", port: 8080 });
    expect(inCidr.decision).toBe("allow");
    if (inCidr.decision === "allow") expect(inCidr.pinned_ips).toEqual(["127.0.0.1"]);

    const outCidr = await policy.decide(context(), { host: "192.0.2.1", port: 80 });
    expect(outCidr.decision).toBe("deny");
  });

  it("DNS rebinding: in-scope on the first lookup, out-of-scope on the second — the second CONNECT denies", async () => {
    const resolver = new FakeResolver();
    let call = 0;
    resolver.answers = () => {
      call += 1;
      return call === 1
        ? [{ address: "203.0.113.10", family: 4 }] // in-scope
        : [{ address: "198.51.100.7", family: 4 }]; // out-of-scope rebound
    };
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      now: () => NOW,
    });
    const first = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(first.decision).toBe("allow");
    const second = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(second.decision).toBe("deny");
    if (second.decision === "deny") {
      expect(second.reason).toContain("198.51.100.7");
    }
  });

  it("window: not-yet-active and expired engagements deny", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      now: () => NOW,
    });
    const early = await policy.decide(
      context({ engagement: engagement({ starts_at: NOW + 60_000 }) }),
      { host: "example.com", port: 443 },
    );
    expect(early.decision).toBe("deny");
    if (early.decision === "deny") expect(early.reason).toContain("engagement_not_yet_active");

    const late = await policy.decide(context({ engagement: engagement({ expires_at: NOW - 1 }) }), {
      host: "example.com",
      port: 443,
    });
    expect(late.decision).toBe("deny");
  });

  it("rate limits: every CONNECT charges the limiter under the LISTENER's class", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    const limiter = new SecurityRateLimiter({ now: () => NOW });
    const policy = createEgressPolicy({ resolver, limiter, now: () => NOW });
    // sqlmap listener (rate_class "sqlmap") charges BOTH the class bucket and
    // the per-host default — same keys the tool layer uses (shared limiter).
    await policy.decide(context({ rate_class: "sqlmap" }), { host: "example.com", port: 443 });
    expect(limiter.bucketCount).toBe(2); // |class:sqlmap| + |host:|
    await policy.decide(context(), { host: "example.com", port: 443 });
    expect(limiter.bucketCount).toBe(2); // same buckets — not new ones
    await policy.decide(context(), { host: "other.example.com", port: 443 });
    expect(limiter.bucketCount).toBe(3); // one more host bucket (default listener, unclassed)
  });

  it("window re-check after the limiter sleep: a CONNECT that queued past expires_at denies", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    // A limiter whose acquire advances the clock past the window end.
    const limiter = new SecurityRateLimiter({
      now: () => NOW,
      sleep: async () => {
        timeline = NOW + 3_700_000;
      },
    });
    let timeline = NOW;
    const { rows, audit } = sink();
    const policy = createEgressPolicy({
      resolver,
      limiter,
      audit,
      now: () => timeline,
    });
    const decision = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toContain("expired");
    // Exactly ONE row per decision — the queued-out deny, not an earlier allow.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.egress.denied");
  });

  it("resolution failure denies cleanly (no throw, audit row written)", async () => {
    const resolver = new FakeResolver();
    resolver.answers = null; // throws inside resolve
    const { rows, audit } = sink();
    const policy = createEgressPolicy({
      resolver,
      limiter: new SecurityRateLimiter({ now: () => NOW }),
      audit,
      now: () => NOW,
    });
    const decision = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(decision.decision).toBe("deny");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.egress.denied");
  });
});

describe("createEgressBinder — listeners, ports, env, rollback", () => {
  it("binds default + one listener per declared rate class, maps ports deterministically", async () => {
    const resolver = new FakeResolver();
    const server = new EgressProxyServer({
      policy: createEgressPolicy({
        resolver,
        limiter: new SecurityRateLimiter({ now: () => NOW }),
        now: () => NOW,
      }),
    });
    afterAll(async () => {
      await server.stop();
    });
    // Class ports derive from basePort+1+i, so a real (non-privileged, free)
    // base is required — probe with retries like an operator picking a port.
    let info: Awaited<ReturnType<SandboxEgressBinding["bindNetwork"]>> | undefined;
    let bound: SandboxEgressBinding | undefined;
    for (let base = 21000 + Math.floor(Math.random() * 20000); base < 65000; base += 13) {
      const binder = createEgressBinder(server, { basePort: base });
      const attempt = await binder
        .bindNetwork("nyx-egress-test", "127.0.0.1", {
          session_id: "sess-1",
          sandbox_id: "sbx-1",
          engagement: engagement(),
        })
        .then(
          (r) => ({ ok: true as const, r }),
          () => ({ ok: false as const }),
        );
      if (attempt.ok) {
        info = attempt.r;
        bound = binder;
        break;
      }
    }
    if (info === undefined || bound === undefined) {
      throw new Error("no free base port for the binder test");
    }
    // default + sqlmap = 2 listeners
    expect(server.listenerCount).toBe(2);
    // null → the default listener; "sqlmap" → the class listener; an
    // UNDECLARED class falls back to the default port (documented bound).
    const def = info.proxyPortFor(null);
    const sqlmap = info.proxyPortFor("sqlmap");
    const undeclared = info.proxyPortFor("nmap");
    expect(def).not.toBe(sqlmap);
    expect(undeclared).toBe(def);
    // env: the default listener is the container-wide proxy; tags are present
    expect(info.env.HTTP_PROXY).toBe(`http://127.0.0.1:${def}`);
    expect(info.env.HTTPS_PROXY).toBe(info.env.HTTP_PROXY);
    expect(info.env.http_proxy).toBe(info.env.HTTP_PROXY);
    expect(info.env.https_proxy).toBe(info.env.HTTP_PROXY);
    expect(info.env.NO_PROXY).toBe("localhost,127.0.0.1,::1");
    expect(info.env.NYX_SESSION_ID).toBe("sess-1");
    expect(info.env.NYX_ENGAGEMENT_ID).toBe("ENG-2026-061");
    expect(info.env.NYX_EGRESS_NETWORK).toBe("nyx-egress-test");
    await bound.unbindNetwork("sbx-1");
    expect(server.listenerCount).toBe(0);
    // idempotent
    await bound.unbindNetwork("sbx-1");
  });

  it("a bind failure rolls back everything the call had bound", async () => {
    // Occupy the class port's slot by pre-binding a raw server on the
    // gateway — the binder's second listener (sqlmap at base+1) fails.
    const squatter = net.createServer(() => undefined);
    await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", resolve));
    const occupied = (squatter.address() as net.AddressInfo).port;

    const resolver = new FakeResolver();
    const server = new EgressProxyServer({
      policy: createEgressPolicy({
        resolver,
        limiter: new SecurityRateLimiter({ now: () => NOW }),
        now: () => NOW,
      }),
    });
    afterAll(async () => {
      squatter.close();
      await server.stop();
    });
    const binder = createEgressBinder(server, { basePort: occupied - 1 });
    // default binds at occupied-1, sqlmap at occupied → collision → reject.
    await expect(
      binder.bindNetwork("nyx-egress-test", "127.0.0.1", {
        session_id: "sess-2",
        sandbox_id: "sbx-2",
        engagement: engagement(),
      }),
    ).rejects.toThrow(/bind/);
    // No half-wired network: the default listener was rolled back too.
    expect(server.listenerCount).toBe(0);
  });
});

// ── Phase 6.4 fan-out regressions (R1-18: honest proofs) ────────────────────

describe("R1-18 — the honest proofs (real policy, real clock)", () => {
  it("TWO-LAYER PROOF with the REAL policy: a raw out-of-scope CONNECT (no tool layer at all) is denied by the proxy's scope engine", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    const { rows, audit } = sink();
    const limiter = new SecurityRateLimiter({ now: () => NOW });
    const policy = createEgressPolicy({ resolver, limiter, audit, now: () => NOW });
    // The REAL engagement fixture authorizes example.com + 203.0.113.0/24
    // (minus the excluded /32) — outsider.test is out of scope.
    const denied = await policy.decide(context(), { host: "outsider.test", port: 443 });
    expect(denied.decision).toBe("deny");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe("security.egress.denied");
    // And the in-scope host still allows through the same real policy.
    const allowed = await policy.decide(context(), { host: "example.com", port: 443 });
    expect(allowed.decision).toBe("allow");
  });

  it("REAL PACING: N CONNECTs through the policy observe the declared rate in wall-clock time", async () => {
    const resolver = new FakeResolver();
    resolver.answers = () => [{ address: "203.0.113.10", family: 4 }];
    // 5 rps declared for the default class + per-host aggregate: 4 decisions
    // take >= 3 intervals (the bucket starts empty) — ~600 ms real time.
    const eng = engagement({
      rate_limits: { default: { requests_per_second: 5 } },
    });
    const limiter = new SecurityRateLimiter(); // REAL clock + REAL sleep
    const policy = createEgressPolicy({ resolver, limiter, now: () => NOW });
    const t0 = Date.now();
    for (let i = 0; i < 4; i += 1) {
      const d = await policy.decide(context({ engagement: eng }), {
        host: "example.com",
        port: 443,
      });
      expect(d.decision).toBe("allow");
    }
    const elapsed = Date.now() - t0;
    // 4 acquires on an empty 5 rps bucket: slots at +200, +400, +600, +800 ms
    // — the last sleeps ~600 ms. Allow scheduler slop, require the floor.
    expect(elapsed).toBeGreaterThanOrEqual(500);
  });
});
