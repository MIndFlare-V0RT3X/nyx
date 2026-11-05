// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.1 — the egress proxy's decision provider + network binder.
//
// The proxy core (@nyx/sandbox egress_proxy/proxy.ts) speaks TCP only; THIS
// module is the kernel-process policy every CONNECT is judged by, composed
// from the Phase 5 pieces:
//
//   1. checkTarget            — window, inclusions, exclusions, port policy
//   2. resolve + checkResolvedTarget — the DNS-rebinding defense; the
//      connection is made to the PINNED, validated IP, never to a name
//   3. SecurityRateLimiter    — per-CONNECT charging (R1-10): the proxy is
//      the enforcement point; buckets live in nyx.db so every kernel
//      process enforces the same slots
//   4. window re-check        — a CONNECT that slept past expires_at denies
//   5. ONE audit row per CONNECT decision (allow and deny alike)
//
// The binder maps a sandbox network to per-rate-class listeners on its
// gateway (attribution by LISTENER, never by client claims — the documented
// bound is in docs/EGRESS-PROXY.md) and produces the env baked into the
// container.

import type { Engagement } from "@nyx/protocol";
import { checkResolvedTarget, checkTarget, isIPLiteral, normalizeHost } from "@nyx/scope";
import type { EgressResolver } from "@nyx/tools";
import type {
  EgressDecision,
  EgressDecisionProvider,
  EgressListenerContext,
  EgressListenerInfo,
  SandboxEgressBinding,
} from "@nyx/sandbox";
import { EgressProxyServer } from "@nyx/sandbox";
import type { EngagementAuditSink } from "../engagement/loader.js";
import type { SecurityRateLimiter } from "./rate_limiter.js";

export interface EgressPolicyDeps {
  resolver: EgressResolver;
  limiter: SecurityRateLimiter;
  /** The engagement audit sink — rows land on the same hash chain as every
   *  other security decision (actor "system:security"). */
  audit?: EngagementAuditSink;
  now?: () => number;
}

/**
 * The per-CONNECT decision provider. Stateless — the listener context
 * carries the engagement snapshot (immutable for the session's life).
 */
export function createEgressPolicy(deps: EgressPolicyDeps): EgressDecisionProvider {
  const now = deps.now ?? Date.now;
  const audit = deps.audit;

  const auditRow = (
    context: EgressListenerContext,
    req: { host: string; port: number },
    allowed: boolean,
    reason: string,
    extra: { matched?: string; pinned_ips?: string[] },
  ): void => {
    audit?.({
      actor: "system:security",
      action: allowed ? "security.egress.allowed" : "security.egress.denied",
      payload: {
        session_id: context.session_id,
        engagement_id: context.engagement.id,
        host: req.host,
        port: req.port,
        rate_class: context.rate_class,
        decision: allowed ? "allow" : "deny",
        reason,
        ...(extra.matched !== undefined ? { matched: extra.matched } : {}),
        ...(extra.pinned_ips !== undefined ? { pinned_ips: extra.pinned_ips } : {}),
      },
    });
  };

  return {
    async decide(context, request): Promise<EgressDecision> {
      const engagement = context.engagement;
      const host = normalizeHost(request.host);

      // 1. The action-time check — window, scope, exclusions, ports.
      const verdict = checkTarget(engagement, { host, port: request.port }, now());
      if (!verdict.allowed) {
        auditRow(context, request, false, verdict.reason, {});
        return { decision: "deny", reason: verdict.reason };
      }

      // 2. Resolution + the rebinding check. IP literals passed checkTarget's
      //    CIDR containment already — they pin to themselves. Hostnames are
      //    resolved (the PROXY's resolver, never the container's) and every
      //    address must be in an authorized CIDR (when the engagement
      //    declares CIDRs; hostname-only engagements load with a Phase 2.0.4
      //    warning and resolve like Phase 5's tool layer).
      let pinnedIps: string[];
      if (isIPLiteral(host)) {
        pinnedIps = [host];
      } else {
        let endpoint;
        try {
          endpoint = await deps.resolver.resolve(host, request.port);
        } catch (err) {
          const reason = `egress resolution failed for ${host}: ${(err as Error).message}`;
          auditRow(context, request, false, reason, {});
          return { decision: "deny", reason };
        }
        const resolved = checkResolvedTarget(
          engagement,
          { host, port: request.port },
          endpoint.ips,
          now(),
        );
        if (!resolved.allowed) {
          auditRow(context, request, false, resolved.reason, {});
          return { decision: "deny", reason: resolved.reason };
        }
        pinnedIps = endpoint.ips.map((a) => a.address);
      }

      // 3. Rate limit — per CONNECT, at the proxy (R1-10). Blocks, never
      //    drops: the CONNECT waits for its slot while the reservation holds.
      await deps.limiter.acquire({
        engagement,
        tool_class: context.rate_class,
        host,
        unit: "requests",
      });

      // 4. The window is the legal authorization boundary: a CONNECT that
      //    slept past expires_at must not fire (the Phase 5 R1-3 discipline,
      //    restated for the proxy).
      if (now() >= engagement.expires_at) {
        const reason =
          `engagement expired at ${new Date(engagement.expires_at).toISOString()} ` +
          "while waiting for the rate limit";
        auditRow(context, request, false, reason, {});
        return { decision: "deny", reason };
      }

      // 5. Allow — connect by pinned IP only.
      const reason = "destination in engagement scope (egress proxy)";
      auditRow(context, request, true, reason, {
        matched: verdict.matched,
        pinned_ips: pinnedIps,
      });
      return {
        decision: "allow",
        reason,
        pinned_ips: pinnedIps,
        ...(verdict.matched !== undefined ? { matched: verdict.matched } : {}),
      };
    },
  };
}

export interface EgressBinderOptions {
  /** Base port on each network gateway (config sandbox.egress_proxy.port). */
  basePort: number;
}

/**
 * Binds a sandbox network's listeners: one per rate class the engagement
 * declares (plus the default listener at the base port). Wrappers that take
 * an explicit proxy flag point at their class's port; env-honoring tools use
 * the default port via HTTP(S)_PROXY. A bind failure unbinds everything the
 * call had already bound and rethrows — the provider then aborts the
 * provision (no proxy, no tools).
 */
export function createEgressBinder(
  server: EgressProxyServer,
  opts: EgressBinderOptions,
): SandboxEgressBinding {
  const basePort = opts.basePort;

  const bindNetwork = async (
    network: string,
    gateway: string,
    context: { session_id: string; sandbox_id: string; engagement: Engagement },
  ): Promise<EgressListenerInfo> => {
    // Tool rate classes: every declared key EXCEPT "default" (the shared
    // per-host aggregate entry — not a tool class; the base listener IS the
    // default's enforcement point).
    const classes = Object.keys(context.engagement.rate_limits ?? {})
      .filter((c) => c !== "default")
      .sort();
    const defaultPort = basePort;
    const classPorts = new Map<string, number>(
      classes.map((c, i) => [c, basePort + 1 + i]),
    );
    const portFor = (rateClass: string | null): number =>
      rateClass === null ? defaultPort : (classPorts.get(rateClass) ?? defaultPort);

    const bound: Array<{ port: number; rateClass: string | null }> = [];
    try {
      await server.bindListener(gateway, defaultPort, {
        session_id: context.session_id,
        sandbox_id: context.sandbox_id,
        engagement: context.engagement,
        rate_class: null,
      });
      bound.push({ port: defaultPort, rateClass: null });
      for (const c of classes) {
        const port = classPorts.get(c);
        if (port === undefined) continue;
        await server.bindListener(gateway, port, {
          session_id: context.session_id,
          sandbox_id: context.sandbox_id,
          engagement: context.engagement,
          rate_class: c,
        });
        bound.push({ port, rateClass: c });
      }
    } catch (err) {
      // Never leave half a network wired — unbind what bound, then rethrow
      // so the sandbox provision aborts (no proxy, no tools).
      await server.unbindNetwork(context.sandbox_id);
      throw err;
    }

    const proxyUrl = `http://${gateway}:${defaultPort}`;
    return {
      proxyPortFor: portFor,
      env: {
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "localhost,127.0.0.1,::1",
        no_proxy: "localhost,127.0.0.1,::1",
        // Observability tags ONLY — the proxy never trusts these (the
        // listener binding is the trust root; see docs/EGRESS-PROXY.md).
        NYX_SESSION_ID: context.session_id,
        NYX_ENGAGEMENT_ID: context.engagement.id,
        NYX_EGRESS_NETWORK: network,
      },
    };
  };

  return {
    bindNetwork,
    unbindNetwork: (sandboxId: string) => server.unbindNetwork(sandboxId),
  };
}
