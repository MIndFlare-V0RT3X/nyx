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

/** `*.example.com` → `example.com` when the base is a valid domain, else null. */
function parseWildcardDomain(entry: string): string | null {
  if (!entry.startsWith("*.")) return null;
  const base = entry.slice(2);
  return isValidDomain(base) ? base : null;
}

/** A domain entry is either a registrable domain or a `*.domain` wildcard. */
function isValidDomainEntry(entry: string): boolean {
  return entry.startsWith("*.") ? parseWildcardDomain(entry) !== null : isValidDomain(entry);
}

/**
 * Dot-boundary suffix match. Plain entries match the apex and every
 * subdomain; wildcard entries (`*.example.com`) match STRICT subdomains
 * only, never the apex (Phase 5 §1.4).
 */
function domainEntryMatches(host: string, entry: string): boolean {
  const e = normalizeDomain(entry);
  if (e.startsWith("*.")) {
    const base = e.slice(2);
    return host !== base && host.endsWith(`.${base}`);
  }
  return host === e || host.endsWith(`.${e}`);
}

/** A structurally parsed URL target entry (Phase 5 §1.4). */
export interface UrlTargetPattern {
  scheme: "http" | "https";
  /** Lowercased host — matched EXACTLY, never by suffix. */
  host: string;
  /** The entry's path. */
  path: string;
  /** Path prefix base when the entry ends in `/*`, else null (exact path). */
  prefix: string | null;
}

/**
 * Parse a URL target entry. http/https only, no userinfo, no query/hash
 * (path-space is the authorization surface), host must be a valid domain or
 * IP literal. A trailing `/*` makes the entry a subtree pattern; a literal
 * `*` anywhere else in the path is refused.
 */
export function parseUrlTarget(entry: string): UrlTargetPattern | null {
  let u: URL;
  try {
    u = new URL(entry);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.search !== "" || u.hash !== "") return null;
  const host = normalizeHost(u.hostname);
  if (host === "") return null;
  if (!isIPLiteral(host) && !isValidDomain(host)) return null;
  const path = u.pathname;
  if (!path.startsWith("/")) return null;
  const scheme: "http" | "https" = u.protocol === "https:" ? "https" : "http";
  if (path.endsWith("/*")) {
    return { scheme, host, path, prefix: path.slice(0, -2) };
  }
  if (path.includes("*")) return null;
  return { scheme, host, path, prefix: null };
}

/** Structural scheme+host+path match of a concrete URL against a pattern. */
function urlEntryMatches(queryUrl: string, pattern: UrlTargetPattern): boolean {
  let u: URL;
  try {
    u = new URL(queryUrl);
  } catch {
    return false;
  }
  if (u.protocol !== `${pattern.scheme}:`) return false;
  if (normalizeHost(u.hostname) !== pattern.host) return false;
  const p = u.pathname;
  if (pattern.prefix === null) return p === pattern.path;
  // Segment-boundary subtree: "/portal/*" matches "/portal" and "/portal/...",
  // never "/portalfoo". A bare "/*" covers the whole path space.
  if (pattern.prefix === "") return p.startsWith("/");
  return p === pattern.prefix || p.startsWith(`${pattern.prefix}/`);
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
    if (!isValidDomainEntry(domain)) {
      problems.push(`invalid domain: ${JSON.stringify(domain)}`);
      continue;
    }
    const key = normalizeDomain(domain);
    if (seenDomains.has(key)) problems.push(`duplicate domain: ${JSON.stringify(domain)}`);
    seenDomains.add(key);
  }

  const seenUrls = new Set<string>();
  for (const url of targets.urls ?? []) {
    const pattern = parseUrlTarget(url);
    if (pattern === null) {
      problems.push(`invalid url target: ${JSON.stringify(url)}`);
      continue;
    }
    const key = `${pattern.scheme}://${pattern.host}${pattern.path}`;
    if (seenUrls.has(key)) problems.push(`duplicate url target: ${JSON.stringify(url)}`);
    seenUrls.add(key);
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
      if (!isValidDomainEntry(domain)) {
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

/** One resolved address of a hostname, as returned by the egress resolver. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Check one egress query against an engagement. Order of evaluation:
 * window start (engagement_not_yet_active) → expiry → inclusion (CIDRs for
 * IP literals, dot-boundary domain suffix or wildcard for hostnames; URL
 * entries when the query carries a URL; domains never authorize raw IPs)
 * → exclusions (override) → port policy (deny list, then allow list) →
 * allow.
 */
export function checkTarget(
  engagement: Engagement,
  query: ScopeTargetQuery,
  now: number = Date.now(),
): ScopeCheckResult {
  if (engagement.starts_at !== undefined && now < engagement.starts_at) {
    return {
      allowed: false,
      reason:
        `engagement_not_yet_active: window opens at ` +
        `${new Date(engagement.starts_at).toISOString()}`,
    };
  }

  if (now >= engagement.expires_at) {
    return {
      allowed: false,
      reason: `engagement expired at ${new Date(engagement.expires_at).toISOString()}`,
    };
  }

  const host = normalizeHost(query.host);
  const targets = engagement.targets;
  const ip = isIPLiteral(host);

  // The port the connection will actually use: explicit, or extracted from a
  // URL query (a URL without an explicit port keeps the scheme default and
  // is not port-restricted here).
  let port = query.port;
  if (port === undefined && query.url !== undefined) {
    try {
      const u = new URL(query.url);
      if (u.port !== "") port = Number(u.port);
    } catch {
      // A malformed URL never reaches the port policy — inclusion denies it.
    }
  }

  let matched: string;
  let viaUrl = false;
  if (ip) {
    const hit = (targets.cidrs ?? []).find((c) => cidrContains(c, host));
    if (hit === undefined) {
      // An IP-literal URL can still be authorized by an exact URL target
      // entry (R2-9) — e.g. urls: ["https://203.0.113.5/portal/*"]. Domains
      // never authorize raw IPs; URL entries authorize their own host form.
      if (query.url !== undefined) {
        const urlHit = (targets.urls ?? []).find((entry) => {
          const pattern = parseUrlTarget(entry);
          return pattern !== null && urlEntryMatches(query.url!, pattern);
        });
        if (urlHit !== undefined) {
          matched = urlHit;
          viaUrl = true;
        } else {
          return {
            allowed: false,
            reason: `ip ${host} not in engagement cidr scope (domains never authorize raw IPs)`,
          };
        }
      } else {
        return {
          allowed: false,
          reason: `ip ${host} not in engagement cidr scope (domains never authorize raw IPs)`,
        };
      }
    } else {
      matched = hit;
    }
  } else {
    const domainHit = (targets.domains ?? []).find((d) => domainEntryMatches(host, d));
    if (domainHit !== undefined) {
      matched = domainHit;
    } else if (query.url !== undefined) {
      const urlHit = (targets.urls ?? []).find((entry) => {
        const pattern = parseUrlTarget(entry);
        return pattern !== null && urlEntryMatches(query.url!, pattern);
      });
      if (urlHit === undefined) {
        return {
          allowed: false,
          reason:
            `url ${query.url} not in engagement scope ` +
            `(no domain or url target matched host ${host})`,
        };
      }
      matched = urlHit;
      viaUrl = true;
    } else {
      return { allowed: false, reason: `host ${host} not in engagement scope` };
    }
  }

  const exclude = targets.exclude;
  if (exclude) {
    if (ip) {
      if ((exclude.cidrs ?? []).some((c) => cidrContains(c, host))) {
        return { allowed: false, reason: "target excluded by engagement" };
      }
    } else if ((exclude.domains ?? []).some((d) => domainEntryMatches(host, d))) {
      return { allowed: false, reason: "target excluded by engagement" };
    }
  }

  const ports = targets.ports;
  if (ports && port !== undefined) {
    if ((ports.deny ?? []).includes(port)) {
      return { allowed: false, reason: `port ${port} denied by engagement` };
    }
    if (ports.allow !== undefined && !ports.allow.includes(port)) {
      return { allowed: false, reason: `port ${port} not in engagement allowed ports` };
    }
  }

  return {
    allowed: true,
    reason: viaUrl ? "url in engagement scope" : "host in engagement scope",
    matched,
  };
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

/**
 * Connection-time scope check for DNS-rebinding defense: the hostname must
 * pass the regular checkTarget authorization AND, when the engagement
 * declares CIDR ranges, every address the hostname actually resolved to must
 * fall inside those ranges (and outside the exclusions). A hostname that
 * matched at policy time but resolves out of scope at connection time is
 * denied with the `dns_rebinding_out_of_scope` reason — an attacker
 * controlling DNS cannot pivot an allowed name onto an internal address.
 *
 * Engagements that declare no CIDRs keep hostname-only authorization (there
 * is no IP range to validate against); that residual is documented in
 * SECURITY-MODEL.md.
 */
export function checkResolvedTarget(
  engagement: Engagement,
  query: ScopeTargetQuery,
  ips: ResolvedAddress[],
  now: number = Date.now(),
): ScopeCheckResult {
  const base = checkTarget(engagement, query, now);
  if (!base.allowed) return base;

  const cidrs = engagement.targets.cidrs ?? [];
  if (cidrs.length === 0) return base;

  for (const { address } of ips) {
    if (!cidrs.some((c) => cidrContains(c, address))) {
      return {
        allowed: false,
        reason:
          `dns_rebinding_out_of_scope: ${query.host} resolved to ${address}, ` +
          "which is outside the engagement cidr scope",
      };
    }
    const exclude = engagement.targets.exclude;
    if (exclude && (exclude.cidrs ?? []).some((c) => cidrContains(c, address))) {
      return {
        allowed: false,
        reason: `dns_rebinding_out_of_scope: ${query.host} resolved to excluded ` + `${address}`,
      };
    }
  }
  return base;
}

/** One-line human summary for prompts, events, and audit records. */
export function engagementSummary(engagement: Engagement): string {
  const bits = [
    `engagement ${engagement.id}`,
    engagement.title ? `"${engagement.title}"` : "",
    `expires ${new Date(engagement.expires_at).toISOString()}`,
    `cidrs: ${engagement.targets.cidrs.join(", ") || "(none)"}`,
    `domains: ${engagement.targets.domains.join(", ") || "(none)"}`,
    engagement.targets.urls !== undefined && engagement.targets.urls.length > 0
      ? `urls: ${engagement.targets.urls.join(", ")}`
      : "",
    engagement.techniques !== undefined && engagement.techniques.length > 0
      ? `techniques: ${engagement.techniques.join(", ")}`
      : "",
  ];
  return bits.filter((b) => b !== "").join(" | ");
}
