// SPDX-License-Identifier: AGPL-3.0-or-later
// Bearer-token auth. The owner token and the named actor tokens come from
// `server.auth` in nyx.config.yaml; when the config has no `server` section
// (headless fallback), the owner token comes from NYX_OWNER_TOKEN or is
// generated at startup and printed once (never persisted). Comparisons are
// timing-safe (sha256 + timingSafeEqual) so token length does not leak.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { NyxServerConfig } from "@nyx/config";

/** The authenticated principal bound to a request. */
export interface Actor {
  id: string;
  is_owner: boolean;
}

/** Effective auth configuration after env fallbacks. */
export interface ResolvedAuth {
  owner_token: string;
  /** actor name → token (the name "owner" is reserved for the owner identity). */
  tokens: ReadonlyMap<string, string>;
  /** True when the owner token was randomly generated this run. */
  generated: boolean;
}

export function randomToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * Resolve the effective auth config.
 * - `server` present in config → its owner_token/tokens verbatim.
 * - absent → owner token from env NYX_OWNER_TOKEN, else a random token
 *   (flagged `generated` so the caller prints it exactly once).
 */
export function resolveAuth(
  server: NyxServerConfig | undefined,
  env: NodeJS.ProcessEnv,
): ResolvedAuth {
  if (server !== undefined) {
    return {
      owner_token: server.auth.owner_token,
      tokens: new Map(Object.entries(server.auth.tokens)),
      generated: false,
    };
  }
  const fromEnv = env.NYX_OWNER_TOKEN;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return { owner_token: fromEnv, tokens: new Map(), generated: false };
  }
  return { owner_token: randomToken(), tokens: new Map(), generated: true };
}

function tokenEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Map a bearer token to its Actor, or null when the token is unknown. */
export function authenticate(token: string, auth: ResolvedAuth): Actor | null {
  if (token.length > 0 && tokenEquals(token, auth.owner_token)) {
    return { id: "owner", is_owner: true };
  }
  for (const [name, candidate] of auth.tokens) {
    if (token.length > 0 && tokenEquals(token, candidate)) {
      return { id: name, is_owner: false };
    }
  }
  return null;
}
