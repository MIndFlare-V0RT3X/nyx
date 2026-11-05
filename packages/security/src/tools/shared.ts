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

import * as path from "node:path";
import * as fsp from "node:fs/promises";
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
  /** argv from the VALIDATED input — every token charset-guarded. May be
   *  async (e.g. ffuf's host-mode wordlist existence check, R3-12). */
  buildArgs: () => string[] | Promise<string[]>;
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

/**
 * Phase 6.1/6.2 — the per-rate-class proxy URL for binaries with an explicit
 * proxy flag (sqlmap --proxy, ffuf -x). The port maps to the engagement's
 * class listener, so per-class limits are enforced AT THE PROXY the tool
 * targets; the per-host default aggregate applies on every listener
 * regardless (docs/EGRESS-PROXY.md). Returns undefined when the sandbox is
 * not egress-proxied (network none / host executor — the Phase 5 posture:
 * the tool layer is then the only gate).
 */
/**
 * Normalize a path-field value to its workspace-RELATIVE form. The tool
 * runtime rewrites path fields to absolute-under-workdir (containment);
 * handlers and sandbox APIs work in the relative form (the sandbox's own
 * exec/readFile re-contain it). Phase 6.2: without this, the rewritten
 * absolute form clashed with the workspace-relative zod shapes (the Phase 5
 * ffuf production path was broken — caught while wiring nuclei templates).
 */
export function workspaceRelative(ctx: ToolContext, p: string): string {
  const workdir = ctx.sandbox?.workdir ?? "";
  if (workdir !== "" && p.startsWith(workdir + "/")) return p.slice(workdir.length + 1);
  return p;
}

/**
 * The handler-level path guard for path-field inputs (Phase 6.2): `..`
 * never passes; an ABSOLUTE path must be inside the sandbox workdir (the
 * runtime's containment rewrite produces exactly that form — a direct
 * handler call with /etc/passwd is still refused, R1-1). Returns the
 * workspace-RELATIVE form for sandbox APIs and argv.
 */
export function assertWorkspacePath(ctx: ToolContext, p: string, label: string): string {
  if (p.split("/").includes("..")) {
    throw Object.assign(
      new Error(`${label} must contain no .. segments`),
      { name: "SecurityToolError", code: "skill.error" as const },
    );
  }
  const workdir = ctx.sandbox?.workdir ?? "";
  if (p.startsWith("/")) {
    if (workdir === "" || !(p === workdir || p.startsWith(workdir + "/"))) {
      throw Object.assign(
        new Error(`${label} "${p}" is absolute and outside the sandbox workdir "${workdir}"`),
        { name: "SecurityToolError", code: "skill.error" as const },
      );
    }
  }
  return workspaceRelative(ctx, p);
}

/**
 * R2-4 (and R3-12's general rule): a workspace file passed to a binary must
 * resolve WHERE THE BINARY READS IT. Sandbox executor: the workspace is the
 * cwd — the (contained) relative path is correct. Real host executor: only
 * the local provider's workdir is host-addressable; resolve absolute under
 * the workdir and fail LOUDLY when the file is not readable on the host
 * (docker+host cannot address workspace files — use the sandbox executor).
 * An injected executor (tests) gets the relative form verbatim.
 */
const resolvePath = (base: string, rel: string) => path.resolve(base, rel);
const fspStat = (p: string) => fsp.stat(p);

export async function resolveForExecutor(
  ctx: ToolContext,
  deps: SecurityToolDeps,
  relPath: string,
  label: string,
): Promise<string> {
  const contained = assertWorkspacePath(ctx, relPath, label);
  const realHost =
    deps.executor instanceof HostSecurityExecutor ||
    (deps.executor === undefined && deps.use_sandbox_executor !== true);
  if (!realHost) return contained;
  const absolute = resolvePath(ctx.sandbox.workdir, contained);
  try {
    const stat = await fspStat(absolute);
    if (!stat.isFile()) throw new Error("not a file");
    return absolute;
  } catch {
    throw Object.assign(
      new Error(
        `${label} "${contained}" is not readable on the host at ${absolute} (the host ` +
          "executor only addresses workspace files with the local provider). Use the " +
          'sandbox executor (security.executor: "sandbox") — the turnkey live mode since ' +
          "the Phase 6.1 egress proxy.",
      ),
      { name: "SecurityToolError", code: "skill.error" as const },
    );
  }
}

export function egressProxyUrl(ctx: ToolContext, rateClass: string): string | undefined {
  const egress = ctx.sandbox?.egress;
  if (egress === undefined) return undefined;
  return `http://${egress.gateway}:${egress.portFor(rateClass)}`;
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
  const args = await opts.buildArgs();
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
  if (meta.unit === "requests") return limits.default?.requests_per_second;
  // Packet-class tools fall back to the default REQUEST rate as a
  // conservative packets ceiling (1 packet per request-rate unit — errs
  // tight; declare nmap.packets_per_second for the real ceiling) (R3-11).
  return limits.default?.requests_per_second;
}
