// SPDX-License-Identifier: AGPL-3.0-or-later
// Egress resolution for web.fetch: the DNS-rebinding defense front line.
//
// The egress policy used to authorize the request *hostname* at policy time
// and then let the transport resolve it again at connection time — an
// attacker controlling DNS could answer the first lookup with an allowed IP
// and the second with an internal one. The resolver here collapses that
// window: hostname → ResolvedEndpoint once per connection, the endpoint is
// what gets scope-checked (checkResolvedTarget) AND what the transport
// connects to (the pinned request never consults DNS again). The pin lives
// for `ttl_ms`, so a burst of requests within one turn reuses one answer
// instead of re-opening the window.

import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import type { ResolvedAddress } from "@nyx/scope";

/** A hostname resolution, pinned for the lifetime of a connection. */
export interface ResolvedEndpoint {
  hostname: string;
  port: number;
  ips: ResolvedAddress[];
  /** Epoch ms after which the pin is stale and a fresh resolve is required. */
  pinned_until: number;
}

/** Resolves an egress hostname to a pinned endpoint. Injected in tests. */
export interface EgressResolver {
  resolve(hostname: string, port: number): Promise<ResolvedEndpoint>;
}

/** Strip exactly one trailing dot ("example.com." → "example.com"). */
export function stripTrailingDot(hostname: string): string {
  return hostname.length > 1 && hostname.endsWith(".")
    ? hostname.slice(0, -1)
    : hostname;
}

export interface DnsEgressResolverOptions {
  /** How long a resolution stays pinned (default 30s). */
  ttl_ms?: number;
  now?: () => number;
  /** Injectable for tests; defaults to node:dns lookup (all addresses). */
  lookup?: (hostname: string) => Promise<LookupAddress[]>;
}

/**
 * Default resolver: node:dns `lookup` (getaddrinfo — honors /etc/hosts and
 * the OS resolver cache), all addresses, pinned for ttl_ms. Numeric hosts
 * pass through as themselves, so IP-literal urls never hit DNS.
 */
export class DnsEgressResolver implements EgressResolver {
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly doLookup: (hostname: string) => Promise<LookupAddress[]>;
  private readonly cache = new Map<string, ResolvedEndpoint>();

  constructor(opts: DnsEgressResolverOptions = {}) {
    this.ttlMs = opts.ttl_ms ?? 30_000;
    this.now = opts.now ?? Date.now;
    this.doLookup = opts.lookup ?? ((hostname) => dnsLookup(hostname, { all: true }));
  }

  async resolve(hostname: string, port: number): Promise<ResolvedEndpoint> {
    const key = hostname.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined && this.now() < cached.pinned_until) {
      // Same pin for the whole window — including the port the endpoint was
      // first resolved for (DNS answers are port-independent).
      return cached;
    }
    const addresses = await this.doLookup(key);
    if (addresses.length === 0) {
      throw new Error(`egress resolver returned no addresses for ${hostname}`);
    }
    const endpoint: ResolvedEndpoint = {
      hostname: key,
      port,
      ips: addresses.map((a) => ({
        address: a.address,
        family: a.family === 6 ? 6 : 4,
      })),
      pinned_until: this.now() + this.ttlMs,
    };
    this.cache.set(key, endpoint);
    return endpoint;
  }
}
