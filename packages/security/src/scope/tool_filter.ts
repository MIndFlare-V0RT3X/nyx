// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §1.3 layer 1 — the STRUCTURAL tool filter.
//
// A security tool whose technique is not in the session's engagement is
// ABSENT from the registry the model sees and the runtime executes — the
// same principle as spawn_subagent at max_depth 0 (Phase 3): the tool cannot
// be listed, called, or hallucinated into existence. A session with NO
// engagement has no offensive tools at all (§1.6). This is not a runtime
// check the model could probe; the registry view never surfaces the tool.

import type {
  ApprovalEngine,
  Engagement,
  EngagementTechnique,
  Kernel,
  PolicyEngine,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
} from "@nyx/protocol";
import { ToolRouterImpl, createToolRuntime } from "@nyx/tools";
import type { ToolRuntime } from "@nyx/tools";

/** What a security tool declares for gating and rate limiting. */
export interface SecurityToolMeta {
  /** The engagement technique this tool exercises. No technique → no tool. */
  technique: EngagementTechnique;
  /** The rate_limits key the tool charges ("ffuf", "nmap", ...). */
  rate_class: string;
  /** The unit the tool's rate bucket counts. */
  unit: "requests" | "packets";
}

/**
 * The security-tool metadata registry. Tool definitions register their meta
 * here at registration time (registerSecurityTools in 5.5); the filter and
 * the scope engine consult it by tool name. Names not present here are NOT
 * security tools and pass through the filter untouched.
 */
const SECURITY_TOOL_META = new Map<string, SecurityToolMeta>();

export function registerSecurityToolMeta(name: string, meta: SecurityToolMeta): void {
  SECURITY_TOOL_META.set(name, meta);
}

export function clearSecurityToolMeta(): void {
  SECURITY_TOOL_META.clear();
}

export function securityToolMeta(name: string): SecurityToolMeta | undefined {
  return SECURITY_TOOL_META.get(name);
}

export function isSecurityTool(name: string): boolean {
  return SECURITY_TOOL_META.has(name);
}

/**
 * The engagement allowlist predicate. A security tool is visible only when
 * the engagement authorizes its technique; non-security tools always pass
 * (they are gated by the ordinary policy/risk machinery, not by technique).
 */
export function engagementToolAllowlist(engagement: Engagement | null): (name: string) => boolean {
  return (name: string): boolean => {
    const meta = SECURITY_TOOL_META.get(name);
    if (meta === undefined) return true;
    if (engagement === null) return false;
    return (engagement.techniques ?? []).includes(meta.technique);
  };
}

/**
 * A read-through registry view (the Phase 3 child-views pattern). list() and
 * get() only ever surface tools the engagement authorizes; register and
 * unregister delegate to the wrapped registry.
 */
export class EngagementToolRegistry implements ToolRegistry {
  constructor(
    private readonly inner: ToolRegistry,
    private readonly allowed: (name: string) => boolean,
  ) {}

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.inner.register(def, handler);
  }

  unregister(name: string): void {
    this.inner.unregister(name);
  }

  list(): ToolDefinition[] {
    return this.inner.list().filter((d) => this.allowed(d.name));
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    return this.allowed(name) ? this.inner.get(name) : null;
  }
}

/**
 * The session kernel with ONE service overridden: "tools.runtime" is a
 * runtime built over the engagement-filtered registry, so the enforcement
 * is on the execution path, not just the model-facing catalog. Everything
 * else (hooks, compaction, services) is shared with the process kernel.
 */
export class EngagementKernelView implements Kernel {
  readonly version: string;
  readonly hooks: Kernel["hooks"];
  readonly tools: ToolRegistry;
  readonly services: Kernel["services"];

  private readonly parent: Kernel;

  constructor(parent: Kernel, engagementRuntime: ToolRuntime) {
    this.parent = parent;
    this.version = parent.version;
    this.hooks = parent.hooks;
    this.tools = parent.tools;
    const parentServices = parent.services;
    this.services = {
      get: <T>(name: string): T | undefined =>
        name === "tools.runtime" ? (engagementRuntime as T) : parentServices.get<T>(name),
      set: (name: string, service: unknown): void => parentServices.set(name, service),
      has: (name: string): boolean => (name === "tools.runtime" ? true : parentServices.has(name)),
      delete: (name: string): void => parentServices.delete(name),
    };
  }

  use(plugin: Parameters<Kernel["use"]>[0]): Promise<void> {
    return this.parent.use(plugin);
  }

  unuse(name: string): Promise<void> {
    return this.parent.unuse(name);
  }
}

/**
 * Build the engagement-scoped tooling for one session: a filtered registry
 * view plus a kernel whose "tools.runtime" executes over it. Sessions
 * WITHOUT an engagement get the same view — every security tool filtered
 * out, non-security tools untouched.
 */
export function buildEngagementTooling(
  base: { tools: ToolRegistry; kernel: Kernel; policy: PolicyEngine; approvals: ApprovalEngine },
  engagement: Engagement | null,
): { tools: ToolRegistry; kernel: Kernel } {
  const filtered = new EngagementToolRegistry(base.tools, engagementToolAllowlist(engagement));
  const runtime = createToolRuntime({
    registry: filtered,
    router: new ToolRouterImpl(),
    policy: base.policy,
    approvals: base.approvals,
  });
  return { tools: filtered, kernel: new EngagementKernelView(base.kernel, runtime) };
}
