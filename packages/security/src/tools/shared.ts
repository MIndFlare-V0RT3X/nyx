// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3 — the shared security-tool pipeline. Every wrapper funnels
// through runSecurityTool, which enforces the three layers in order:
//
//   layer 3 (action-time): the scope engine check — one audit row per call
//   (allow AND deny carry the engagement id and action digest).
//   layer 2 (egress path): pinned DNS resolution + checkResolvedTarget per
//   hostname (the DNS-rebinding defense) — a target that resolved in-scope
//   at policy time but out-of-scope at connection time never fires.
//   rate:      the token bucket per (engagement, class, host) — blocks,
//   never drops; the binary also receives its own cooperative rate flag
//   derived from the engagement.
//
// Only then does the executor see an argv composed exclusively of
// handler-validated tokens (charset-guarded — see executor.ts).

import type {
  Engagement,
  ScopeTargetQuery,
  ToolContext,
  ToolOutput,
} from "@nyx/protocol";
import { checkResolvedTarget, normalizeHost } from "@nyx/scope";
import type { EgressResolver } from "@nyx/tools";
import { createScopeEngine } from "../scope/engine.js";
import type { EngagementAuditSink } from "../engagement/loader.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { SecurityRateLimiter } from "../scope/rate_limiter.js";
import { HostSecurityExecutor, SandboxSecurityExecutor } from "./executor.js";
import type { SecurityExecutor } from "./executor.js";

/** Everything a security tool needs beyond the runtime's ToolContext. */
export interface SecurityToolDeps {
  /** Injected executor (tests). When absent, resolved per call. */
  executor?: SecurityExecutor;
  /** With no injected executor: run the binaries in the session sandbox. */
  use_sandbox_executor?: boolean;
  resolver: EgressResolver;
  limiter: SecurityRateLimiter;
  now?: () => number;
  audit?: EngagementAuditSink;
}

export interface RunSecurityToolOptions {
  tool: string;
  binary: string;
  meta: SecurityToolMeta;
  ctx: ToolContext;
  deps: SecurityToolDeps;
  /** The action's network targets (already parsed and schema-validated). */
  targets: ScopeTargetQuery[];
  /** argv from the VALIDATED input — every token charset-guarded. */
  buildArgs: () => string[];
  /** Map the binary's stdout into the tool output (throws on malformed). */
  parse: (stdout: string, ctx: ToolContext) => Promise<ToolOutput>;
  timeout_ms?: number;
}

export function denied(ctx: ToolContext, detail: string): ToolOutput {
  // The same shape the runtime's own scope denials produce — the model sees
  // a denied text, the event log sees action.denied.
  ctx.emit({
    type: "action.denied",
    session_id: ctx.session_id,
    turn_id: ctx.turn_id,
    call_id: ctx.call_id,
    reason: "scope",
    detail,
    ts: Date.now(),
  });
  return { kind: "text", text: `denied by scope: ${detail}` };
}

export async function runSecurityTool(opts: RunSecurityToolOptions): Promise<ToolOutput> {
  const { ctx, deps, meta, tool } = opts;
  const now = deps.now ?? Date.now;

  const engagement: Engagement | null = ctx.engagement;
  if (engagement === null) {
    return denied(ctx, "no engagement declared for this session; security tools are denied");
  }

  // Layer 3 — the action-time check (audit row for allow AND deny).
  const engine = createScopeEngine(engagement, { now, audit: deps.audit });
  const outcome = engine.check({ tool, targets: opts.targets });
  if (outcome.decision !== "allow") {
    return denied(ctx, outcome.reason);
  }

  // Layer 2 — pinned resolution + the DNS-rebinding check per target. The
  // resolver sees the NORMALIZED host (R1-7: bracketed IPv6 literals would
  // otherwise pass scope and crash getaddrinfo).
  for (const target of opts.targets) {
    if (target.host.includes("/")) continue; // CIDR targets (nmap) skip DNS
    const port = target.port ?? 443;
    const host = normalizeHost(target.host);
    const endpoint = await deps.resolver.resolve(host, port);
    const verdict = checkResolvedTarget(engagement, target, endpoint.ips, now());
    if (!verdict.allowed) {
      return denied(ctx, verdict.reason);
    }
  }

  // Rate limit per distinct NORMALIZED host (R1-4: a trailing-dot variant
  // must not split one host into two buckets) — blocks (sleeps), never drops.
  const hosts = [...new Set(opts.targets.map((t) => normalizeHost(t.host)))];
  for (const host of hosts) {
    await deps.limiter.acquire({ engagement, tool_class: meta.rate_class, host, unit: meta.unit });
  }

  // The window is the legal authorization boundary (R1-3): re-check it after
  // the limiter's sleep — a call that passed layer 3 but slept past
  // expires_at must not fire — and cap the binary's runtime to the window.
  const wallNow = (deps.now ?? Date.now)();
  if (wallNow >= engagement.expires_at) {
    return denied(
      ctx,
      `engagement expired at ${new Date(engagement.expires_at).toISOString()} while waiting for the rate limit`,
    );
  }

  // Fire — argv composed only from validated input, charset-guarded. The
  // executor resolves per call when not injected: the session sandbox (the
  // sandbox's own exec transport) or the host with no shell.
  const args = opts.buildArgs();
  const executor: SecurityExecutor =
    deps.executor ??
    (deps.use_sandbox_executor === true
      ? new SandboxSecurityExecutor(ctx.sandbox)
      : new HostSecurityExecutor());
  const remainingWindow = engagement.expires_at - wallNow;
  const requested = opts.timeout_ms ?? 600_000;
  const result = await executor.run(opts.binary, args, {
    timeout_ms: Math.max(1_000, Math.min(requested, remainingWindow)),
  });
  if (result.exit_code !== 0) {
    throw Object.assign(
      new Error(
        `${opts.binary} exited ${result.exit_code}: ${result.stderr.slice(0, 2000)}`,
      ),
      { name: "SecurityToolError", code: "skill.error" as const },
    );
  }
  return await opts.parse(result.stdout, ctx);
}

/** JSONL line reader with malformed-line rejection (§3.3: skill.error). */
export function parseJsonl(stdout: string): unknown[] {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const out: unknown[] = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {
      throw Object.assign(
        new Error(`malformed JSONL from the tool: ${line.slice(0, 200)}`),
        { name: "SecurityToolError", code: "skill.error" },
      );
    }
  }
  return out;
}

/** The binary's cooperative rate flag value, derived from the engagement. */
export function cooperativeRate(
  engagement: Engagement,
  meta: SecurityToolMeta,
): number | undefined {
  const limits = engagement.rate_limits ?? {};
  const own = limits[meta.rate_class];
  const rate =
    meta.unit === "requests" ? own?.requests_per_second : own?.packets_per_second;
  if (rate !== undefined) return rate;
  return meta.unit === "requests" ? limits.default?.requests_per_second : undefined;
}
