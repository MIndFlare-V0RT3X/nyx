// SPDX-License-Identifier: AGPL-3.0-or-later
// Engagement scope engine: pure functions over the immutable Engagement
// contract. Every security-relevant network egress check funnels through
// checkTarget / makeScopeChecker. Deny-first: any doubt is a deny.

import type {
  Engagement,
  ScopeCheckResult,
  ScopeChecker,
  ScopeTargetQuery,
  ScopeTargets,
} from "@nyx/protocol";
import { cidrContains, isIPLiteral, normalizeHost, parseCidr } from "./ip.js";

const DOMAIN_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TLD_LABEL = /^[a-z]{2,63}$/;

function isValidDomain(domain: string): boolean {
  if (domain.length === 0 || domain.length > 253) return false;
  const labels = domain.toLowerCase().split(".");
  if (labels.length < 2) return false;
  const tld = labels[labels.length - 1];
  if (tld === undefined || !TLD_LABEL.test(tld)) return false;
  return labels.every((l) => l.length <= 63 && DOMAIN_LABEL.test(l));
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function normalizeDomain(domain: string): string {
  const d = domain.trim().toLowerCase();
  return d.length > 1 && d.endsWith(".") ? d.slice(0, -1) : d;
}

/**
 * Validate a target set at session-creation time. Returns a list of
 * human-readable problems; empty means valid. Checks CIDR syntax,
 * registrable-style domain syntax, port sanity, and duplicate entries
 * (duplicates are compared case-insensitively for domains, exactly for CIDRs).
 */
export function validateTargets(targets: ScopeTargets): string[] {
  const problems: string[] = [];

  const seenCidrs = new Set<string>();
  for (const cidr of targets.cidrs ?? []) {
    if (parseCidr(cidr) === null) {
      problems.push(`invalid CIDR: ${JSON.stringify(cidr)}`);
      continue;
    }
    if (seenCidrs.has(cidr)) problems.push(`duplicate CIDR: ${JSON.stringify(cidr)}`);
    seenCidrs.add(cidr);
  }

  const seenDomains = new Set<string>();
  for (const domain of targets.domains ?? []) {
    if (!isValidDomain(domain)) {
      problems.push(`invalid domain: ${JSON.stringify(domain)}`);
      continue;
    }
    const key = normalizeDomain(domain);
    if (seenDomains.has(key)) problems.push(`duplicate domain: ${JSON.stringify(domain)}`);
    seenDomains.add(key);
  }

  const exclude = targets.exclude;
  if (exclude) {
    const seenExCidrs = new Set<string>();
    for (const cidr of exclude.cidrs ?? []) {
      if (parseCidr(cidr) === null) {
        problems.push(`invalid CIDR in exclude: ${JSON.stringify(cidr)}`);
        continue;
      }
      if (seenExCidrs.has(cidr)) problems.push(`duplicate excluded CIDR: ${JSON.stringify(cidr)}`);
      seenExCidrs.add(cidr);
    }
    const seenExDomains = new Set<string>();
    for (const domain of exclude.domains ?? []) {
      if (!isValidDomain(domain)) {
        problems.push(`invalid domain in exclude: ${JSON.stringify(domain)}`);
        continue;
      }
      const key = normalizeDomain(domain);
      if (seenExDomains.has(key))
        problems.push(`duplicate excluded domain: ${JSON.stringify(domain)}`);
      seenExDomains.add(key);
    }
  }

  const ports = targets.ports;
  if (ports) {
    const checkPortList = (list: number[] | undefined, which: string): void => {
      const seen = new Set<number>();
      for (const p of list ?? []) {
        if (!Number.isInteger(p) || p < 1 || p > 65535) {
          problems.push(`invalid port in ${which} list: ${p}`);
          continue;
        }
        if (seen.has(p)) problems.push(`duplicate port in ${which} list: ${p}`);
        seen.add(p);
      }
    };
    checkPortList(ports.allow, "allow");
    checkPortList(ports.deny, "deny");
  }

  return problems;
}

/**
 * Check one egress query against an engagement. Order of evaluation:
 * expiry → inclusion (CIDRs for IP literals, dot-boundary domain suffix for
 * hostnames; domains never authorize raw IPs) → exclusions (override) →
 * port policy (deny list, then allow list) → allow.
 */
export function checkTarget(
  engagement: Engagement,
  query: ScopeTargetQuery,
  now: number = Date.now(),
): ScopeCheckResult {
  if (now >= engagement.expires_at) {
    return {
      allowed: false,
      reason: `engagement expired at ${new Date(engagement.expires_at).toISOString()}`,
    };
  }

  const host = normalizeHost(query.host);
  const targets = engagement.targets;
  const ip = isIPLiteral(host);

  let matched: string;
  if (ip) {
    const hit = (targets.cidrs ?? []).find((c) => cidrContains(c, host));
    if (hit === undefined) {
      return {
        allowed: false,
        reason: `ip ${host} not in engagement cidr scope (domains never authorize raw IPs)`,
      };
    }
    matched = hit;
  } else {
    const hit = (targets.domains ?? []).find((d) => domainMatches(host, normalizeDomain(d)));
    if (hit === undefined) {
      return { allowed: false, reason: `host ${host} not in engagement scope` };
    }
    matched = hit;
  }

  const exclude = targets.exclude;
  if (exclude) {
    if (ip) {
      if ((exclude.cidrs ?? []).some((c) => cidrContains(c, host))) {
        return { allowed: false, reason: "target excluded by engagement" };
      }
    } else if ((exclude.domains ?? []).some((d) => domainMatches(host, normalizeDomain(d)))) {
      return { allowed: false, reason: "target excluded by engagement" };
    }
  }

  const ports = targets.ports;
  if (ports && query.port !== undefined) {
    if ((ports.deny ?? []).includes(query.port)) {
      return { allowed: false, reason: `port ${query.port} denied by engagement` };
    }
    if (ports.allow !== undefined && !ports.allow.includes(query.port)) {
      return { allowed: false, reason: `port ${query.port} not in engagement allowed ports` };
    }
  }

  return { allowed: true, reason: "host in engagement scope", matched };
}

/**
 * Bind an engagement into a ScopeChecker closure for the tool runtime. `now`
 * is injectable for tests and defaults to Date.now.
 */
export function makeScopeChecker(
  engagement: Engagement,
  now: () => number = Date.now,
): ScopeChecker {
  return (query: ScopeTargetQuery) => checkTarget(engagement, query, now());
}

/** One-line human summary for prompts, events, and audit records. */
export function engagementSummary(engagement: Engagement): string {
  const bits = [
    `engagement ${engagement.id}`,
    engagement.title ? `"${engagement.title}"` : "",
    `expires ${new Date(engagement.expires_at).toISOString()}`,
    `cidrs: ${engagement.targets.cidrs.join(", ") || "(none)"}`,
    `domains: ${engagement.targets.domains.join(", ") || "(none)"}`,
  ];
  return bits.filter((b) => b !== "").join(" | ");
}
