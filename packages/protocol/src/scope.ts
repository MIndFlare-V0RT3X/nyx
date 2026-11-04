// SPDX-License-Identifier: AGPL-3.0-or-later
// Engagement scope: the immutable target set bound to a session at creation.
// The scope engine (@nyx/scope) evaluates targets; these are the shapes that
// cross process boundaries (config → server → session store → tools).

/** Declared target set for an engagement. */
export interface ScopeTargets {
  /** IPv4/IPv6 CIDR blocks, e.g. "10.0.0.0/8", "2001:db8::/32". */
  cidrs: string[];
  /** Domain suffixes, e.g. "example.com" covers "app.example.com" but NOT "evil-example.com".
   * Entries may be wildcards: "*.example.com" matches strict subdomains only,
   * never the apex (Phase 5 §1.4). */
  domains: string[];
  /** URL targets (Phase 5 §1.4): "https://app.example.com/portal/*" — scheme,
   * host, and path are each matched structurally. A trailing `/*` matches the
   * path subtree on segment boundaries. URL entries authorize exactly their
   * own scheme/host/path-space: never a bare host, never another scheme. */
  urls?: string[];
  /** Optional port policy. Allow list (when set) restricts; deny list always overrides. */
  ports?: { allow?: number[]; deny?: number[] };
  /** Explicit carve-outs that override the allow sets above (domains, wildcards, CIDRs). */
  exclude?: { cidrs?: string[]; domains?: string[] };
}

/**
 * Attack classes an engagement may authorize (Phase 5 §1.2). Absent or empty
 * means NONE: technique-gated tools are structurally absent from the registry.
 * Phase 5 ships tooling for the first four only; `exploitation` and
 * `social_engineering` exist in the contract but no Phase 5 tool maps to them.
 */
export type EngagementTechnique =
  | "reconnaissance"
  | "port_scanning"
  | "web_enumeration"
  | "vulnerability_scanning"
  | "exploitation"
  | "social_engineering";

/** One rate-limit bucket entry: HTTP-class requests or packet-class scans. */
export interface EngagementRateLimit {
  requests_per_second?: number;
  packets_per_second?: number;
}

/**
 * Per-tool-class rate limits (Phase 5 §1.5). The `default` entry is the
 * fallback for tools without a specific class AND the shared per-host
 * aggregate ceiling for request-rate tools; other keys name tool rate
 * classes (e.g. "ffuf", "nmap").
 */
export interface EngagementRateLimits {
  default?: EngagementRateLimit;
  [tool_class: string]: EngagementRateLimit | undefined;
}

/**
 * An authorized engagement. Bound to a session at creation and immutable for
 * the session's life. Security-relevant network egress is checked against
 * `targets`; an expired engagement denies everything.
 */
export interface Engagement {
  /** Operator-facing reference, e.g. "ENG-2026-042". */
  id: string;
  title?: string;
  /** Who authorized the engagement (must match the owner for R4 flows). */
  operator_id: string;
  authorized_at: number;
  /** Unix ms. Before this moment every scope check denies (engagement_not_yet_active, Phase 5 §1.7). */
  starts_at?: number;
  /** Unix ms. After this moment every scope check denies. */
  expires_at: number;
  targets: ScopeTargets;
  /** Attack classes this engagement authorizes (Phase 5 §1.2). Absent = none. */
  techniques?: EngagementTechnique[];
  /** Per-tool-class rate limits (Phase 5 §1.5). */
  rate_limits?: EngagementRateLimits;
  /** Engagement metadata surfaced in reports (Phase 5 §1.2). */
  client?: string;
  authorized_by?: string;
  emergency_contact?: string;
  /** Free-form rules of engagement surfaced to the persona and audit log. */
  rules?: string[];
}

export interface ScopeCheckResult {
  allowed: boolean;
  /** Human-readable, bound to this exact check (used in events and audit). */
  reason: string;
  /** Which target matched, when allowed. */
  matched?: string;
}

export interface ScopeTargetQuery {
  host: string;
  port?: number;
  /** Full absolute URL (http/https). When present, URL target entries are
   * consulted — matched structurally on scheme, host, and path (Phase 5 §1.4).
   * URL entries never authorize a host-only query and a domain entry never
   * leans on the URL: the two authorization classes stay independent. */
  url?: string;
}

/** Pure function contract the tool runtime uses for net.egress checks. */
export type ScopeChecker = (query: ScopeTargetQuery) => ScopeCheckResult;
