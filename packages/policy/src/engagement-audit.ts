// SPDX-License-Identifier: AGPL-3.0-or-later
// Engagement-creation audit (2.0.4). Every session created WITH an engagement
// writes an `engagement.created` row into the hash-chained audit log. For a
// domain-only engagement (domains declared, no CIDR constraint) the row
// includes the INITIAL DNS resolution's addresses, giving the operator a
// post-hoc way to validate what the runtime pin trusted. CIDR-constrained
// engagements record the constraint instead.
//
// This changes NO runtime behavior: the Phase 1 DNS-rebinding defense still
// resolves at connection time, pins the result, and authorizes the resolved
// IPs against the engagement's CIDRs. This is bookkeeping about trust, not a
// new gate.

import { lookup } from "node:dns/promises";
import type { Engagement, Logger } from "@nyx/protocol";

/** Resolved address of one hostname (dns.lookup { all: true } shape). */
export interface ResolvedAddress {
  address: string;
  family: number;
}

export type DnsResolver = (host: string) => Promise<ResolvedAddress[]>;

/** Default resolver: the OS resolver via node:dns, capped at 2s. */
async function defaultResolve(host: string): Promise<ResolvedAddress[]> {
  const timeout = new Promise<ResolvedAddress[]>((resolve) => {
    setTimeout(() => resolve([]), 2_000).unref?.();
  });
  const result = await Promise.race([lookup(host, { all: true }), timeout]);
  return result;
}

export interface EngagementAuditDeps {
  /** The hash-chain audit sink (the approval engine handle's `audit`). */
  audit: (entry: { actor: string; action: string; payload: unknown }) => void;
  logger?: Logger;
  /** Test seam; default is node:dns with a 2s cap. */
  resolve?: DnsResolver;
  now?: () => number;
}

export interface EngagementCreatedInput {
  session_id: string;
  engagement: Engagement;
  owner_id: string;
}

/** True when domains are declared but no CIDR constrains their resolutions. */
export function isDomainOnlyEngagement(engagement: Engagement): boolean {
  const domains = engagement.targets.domains ?? [];
  const cidrs = engagement.targets.cidrs ?? [];
  return domains.length > 0 && cidrs.length === 0;
}

/**
 * Record the engagement binding on the audit chain. Never throws: a DNS
 * failure or a slow resolver is recorded in the row, not a session-creation
 * failure — creation-time resolution is informational (the runtime pin does
 * its own resolution at connection time).
 */
export async function auditEngagementCreated(
  deps: EngagementAuditDeps,
  input: EngagementCreatedInput,
): Promise<void> {
  const { engagement, session_id, owner_id } = input;
  const resolve = deps.resolve ?? defaultResolve;
  const now = deps.now ?? Date.now;
  const domains = engagement.targets.domains ?? [];
  const cidrs = engagement.targets.cidrs ?? [];
  const domainOnly = isDomainOnlyEngagement(engagement);

  const resolvedDomains: Array<
    { domain: string; resolved_ips: string[]; error?: string } | { domain: string; resolved_ips: string[] }
  > = [];
  if (domainOnly) {
    for (const domain of domains) {
      try {
        const addresses = await resolve(domain);
        resolvedDomains.push({
          domain,
          resolved_ips: addresses.map((a) => a.address),
          ...(addresses.length === 0 ? { error: "no addresses returned (or resolution timed out)" } : {}),
        });
      } catch (err) {
        resolvedDomains.push({
          domain,
          resolved_ips: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    deps.logger?.warn("engagement.domain_only", {
      session_id,
      engagement_id: engagement.id,
      domains,
      hint: "no CIDR constraint; the runtime pin trusts the first resolution — initial resolution recorded in the audit log",
    });
  }

  deps.audit({
    actor: owner_id,
    action: "engagement.created",
    payload: {
      session_id,
      engagement_id: engagement.id,
      operator_id: engagement.operator_id,
      domain_only: domainOnly,
      cidrs,
      domains: domainOnly ? resolvedDomains : domains,
      resolved_at: now(),
      ...(domainOnly
        ? {
            warning:
              "domain-only engagement: the runtime pins the first connection-time resolution; the addresses above are the creation-time resolution, recorded for post-hoc validation",
          }
        : {
            note: "resolved IPs are pinned at connection time and authorized against the CIDR allowlist",
          }),
    },
  });
}
