// SPDX-License-Identifier: AGPL-3.0-or-later
// Engagement scope: the immutable target set bound to a session at creation.
// The scope engine (@nyx/scope) evaluates targets; these are the shapes that
// cross process boundaries (config → server → session store → tools).

/** Declared target set for an engagement. */
export interface ScopeTargets {
  /** IPv4/IPv6 CIDR blocks, e.g. "10.0.0.0/8", "2001:db8::/32". */
  cidrs: string[];
  /** Domain suffixes, e.g. "example.com" covers "app.example.com" but NOT "evil-example.com". */
  domains: string[];
  /** Optional port policy. Allow list (when set) restricts; deny list always overrides. */
  ports?: { allow?: number[]; deny?: number[] };
  /** Explicit carve-outs that override the allow sets above. */
  exclude?: { cidrs?: string[]; domains?: string[] };
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
  /** Unix ms. After this moment every scope check denies. */
  expires_at: number;
  targets: ScopeTargets;
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
}

/** Pure function contract the tool runtime uses for net.egress checks. */
export type ScopeChecker = (query: ScopeTargetQuery) => ScopeCheckResult;
