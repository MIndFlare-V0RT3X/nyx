// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — egress proxy contracts.
//
// The proxy is the structural fix for Phase 5's R1-2 ("binaries re-resolve at
// exec time"): a sandboxed binary cannot reach ANY address except the bridge
// gateway, where this proxy listens. Every outbound connection is a CONNECT
// that goes through the decision provider (the scope engine + resolved-target
// check + rate limiter, in the kernel process) and connects by PINNED IP.
//
// These types are deliberately dependency-free beyond @nyx/protocol: the
// proxy core (proxy.ts) speaks node:net only, and @nyx/security implements
// the decision provider + binder. See docs/EGRESS-PROXY.md.

import type { Engagement } from "@nyx/protocol";

/** Per-listener identity — WHO the connections belong to. */
export interface EgressListenerContext {
  session_id: string;
  sandbox_id: string;
  engagement: Engagement;
  /**
   * The rate class this listener charges (the base/default listener passes
   * null). Attribution is by LISTENER (port), never by client claims —
   * see docs/EGRESS-PROXY.md "Rate-class attribution" for the documented
   * bound.
   */
  rate_class: string | null;
}

/** One parsed CONNECT request. */
export interface EgressConnectRequest {
  host: string;
  port: number;
}

/** Allow: connect to one of the pinned addresses, in order. */
export interface EgressDecisionAllow {
  decision: "allow";
  reason: string;
  pinned_ips: string[];
  matched?: string;
}

/** Deny: destroy the socket (RST semantics); no response bytes are sent. */
export interface EgressDecisionDeny {
  decision: "deny";
  reason: string;
}

export type EgressDecision = EgressDecisionAllow | EgressDecisionDeny;

/**
 * The in-kernel-process "IPC" the proxy calls per CONNECT. Implemented by
 * @nyx/security's createEgressPolicy (scope engine + resolved-target check +
 * rate limiter + one audit row per decision). Synchronous contract point, so
 * the proxy core needs no knowledge of scope, engagements, or SQLite.
 */
export interface EgressDecisionProvider {
  decide(context: EgressListenerContext, request: EgressConnectRequest): Promise<EgressDecision>;
}

/** What the docker provider needs from the proxy side to wire a network. */
export interface SandboxEgressBinding {
  /**
   * Bind the per-class listeners on a freshly created network's gateway.
   * Throws on bind failure — the provider then aborts the sandbox provision
   * (no proxy, no tools).
   *
   * @param network   the docker network name (for bookkeeping/logging).
   * @param gateway   the network's gateway IP (where the listeners bind).
   * @param context   session/sandbox/engagement identity for the listeners.
   * @returns the port mapper plus the env vars to bake into the container
   *          (HTTP(S)_PROXY for the default listener, observability tags).
   */
  bindNetwork(
    network: string,
    gateway: string,
    context: { session_id: string; sandbox_id: string; engagement: Engagement },
  ): Promise<EgressListenerInfo>;

  /** Unbind a sandbox's listeners. Idempotent; safe to call from any of the
   *  network's sandboxes (parent or forks) — the last one out closes them. */
  unbindNetwork(sandbox_id: string): Promise<void>;
}

/** Per-sandbox egress wiring returned by bindNetwork. */
export interface EgressListenerInfo {
  /** Port for a rate class (null = the engagement default). */
  proxyPortFor(rateClass: string | null): number;
  /** Env vars merged into the container's base env. */
  env: Record<string, string>;
}
