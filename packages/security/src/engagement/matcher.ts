// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.4 — the matcher surface for the security subsystem.
//
// The matching CORE lives in `@nyx/scope` (checkTarget / checkResolvedTarget /
// validateTargets) and is extended there (wildcards, URL targets, window
// start). This module re-exports that surface for security-package consumers
// and adds the URL convenience the security tools use: every tool target is
// a URL, and checkUrl parses it into the host/port/url query the engine
// evaluates. No tool ever string-matches scope itself.

import type { Engagement, ScopeCheckResult } from "@nyx/protocol";
import { checkTarget } from "@nyx/scope";

export {
  checkTarget,
  checkResolvedTarget,
  makeScopeChecker,
  validateTargets,
  engagementSummary,
  parseUrlTarget,
} from "@nyx/scope";

/** A parsed action URL: the pieces the scope engine evaluates. */
export interface ParsedActionUrl {
  host: string;
  port?: number;
  url: string;
}

/** Parse an action URL into an egress query. Returns null when malformed. */
export function parseActionUrl(target: string): ParsedActionUrl | null {
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username !== "" || u.password !== "") return null;
  const host = u.hostname.toLowerCase();
  if (host === "") return null;
  return {
    host,
    ...(u.port !== "" ? { port: Number(u.port) } : {}),
    url: u.toString(),
  };
}

/**
 * Check a concrete action URL against an engagement — the single entry point
 * security tools use before anything fires. Structural on scheme, host, and
 * path; window, exclusions, and port policy all apply.
 */
export function checkUrl(
  engagement: Engagement,
  target: string,
  now: number = Date.now(),
): ScopeCheckResult {
  const parsed = parseActionUrl(target);
  if (parsed === null) {
    return {
      allowed: false,
      reason: `malformed action url: ${JSON.stringify(target)} (http/https absolute URL required)`,
    };
  }
  return checkTarget(engagement, parsed, now);
}
