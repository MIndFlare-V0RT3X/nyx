// SPDX-License-Identifier: AGPL-3.0-or-later
// The child RunContext's structural views (Phase 3 §2.6):
//
//   FilteredToolRegistry — the only tools the child can list, get, or
//   execute. spawn_subagent is absent BY CONSTRUCTION (the predicate rejects
//   it regardless of config), so an attempted call routes to "unknown tool".
//
//   ChildKernelView — the parent kernel with ONE service overridden:
//   "tools.runtime" is a runtime built over the FILTERED registry, so the
//   enforcement is on the execution path, not just the model-facing catalog.
//   Everything else (hooks, compaction pipeline, services) is shared.
//
//   BudgetTrackingRouter — the parent model router with a per-subagent token
//   counter. When the child's spend crosses its budget the child's
//   AbortController fires: the turn ends, the manager records
//   state="budget_exceeded". usage accounting (recordUsage/checkBudget)
//   delegates keyed by the child session id.

import type {
  Kernel,
  MemoryStore,
  Message,
  ModelRouter,
  CompletionRequest,
  ModelChunk,
  Plugin,
  RouteOptions,
  RunContext,
  SessionEvent,
  ToolDefinition,
  ToolHandler,
  ToolRegistry,
  Usage,
} from "@nyx/protocol";
import { ToolRouterImpl, createToolRuntime } from "@nyx/tools";
import type { ToolRuntime } from "@nyx/tools";
import type { SubagentsConfig } from "./config.js";
import { ExtraToolsRegistry } from "./artifacts.js";
import { SubagentMemory } from "./memory-view.js";

/**
 * A read-through registry view. `list()`/`get()` only ever surface allowed
 * tools; `register`/`unregister` delegate to the wrapped registry (the loop
 * never calls them; plugins that do behave exactly as they would against the
 * parent registry).
 */
export class FilteredToolRegistry implements ToolRegistry {
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
 * The child's tool allowlist predicate. Three gates, in order:
 *   1. spawn_subagent NEVER passes — hard rule #1, structural, not config;
 *   2. config.forbidden_tools never passes — cannot be overridden;
 *   3. the spec's allowlist (or the config default) must name the tool, and
 *      it must exist in the parent's registry (an allowlist naming a tool
 *      the parent doesn't have grants nothing).
 */
export function childToolAllowlist(
  requested: readonly string[],
  config: SubagentsConfig,
  parentRegistry: ToolRegistry,
): (name: string) => boolean {
  const requestedSet = new Set(requested);
  const forbidden = new Set(config.forbidden_tools);
  const parentHas = new Set(parentRegistry.list().map((d) => d.name));
  return (name: string): boolean =>
    name !== "spawn_subagent" &&
    !forbidden.has(name) &&
    requestedSet.has(name) &&
    parentHas.has(name);
}

/** The parent kernel with "tools.runtime" replaced by the child's filtered runtime. */
export class ChildKernelView implements Kernel {
  readonly version: string;
  readonly hooks: Kernel["hooks"];
  readonly tools: ToolRegistry;
  readonly services: Kernel["services"];

  private readonly parent: Kernel;

  constructor(parent: Kernel, childRuntime: ToolRuntime) {
    this.parent = parent;
    this.version = parent.version;
    this.hooks = parent.hooks;
    this.tools = parent.tools;
    const parentServices = parent.services;
    this.services = {
      get: <T>(name: string): T | undefined =>
        name === "tools.runtime" ? (childRuntime as T) : parentServices.get<T>(name),
      set: (name: string, service: unknown): void => parentServices.set(name, service),
      has: (name: string): boolean =>
        name === "tools.runtime" ? true : parentServices.has(name),
      delete: (name: string): void => parentServices.delete(name),
    };
  }

  // Plugin lifecycle delegates to the parent kernel: a plugin loaded while a
  // child turn runs is loaded for the process, exactly as if the parent turn
  // had loaded it.
  use(plugin: Plugin): Promise<void> {
    return this.parent.use(plugin);
  }

  unuse(name: string): Promise<void> {
    return this.parent.unuse(name);
  }
}

/** Builds the filtered registry + kernel view + child runtime for one spawn.
 * `extra` (fork mode: subagent_artifact) rides on TOP of the filtered view —
 * INSIDE both the registry the model sees and the runtime that executes, so
 * the extras are harness-granted, allowlist-exempt by construction. */
export function buildChildTooling(
  parent_ctx: RunContext,
  requestedTools: readonly string[],
  config: SubagentsConfig,
  extra: Array<{ def: ToolDefinition; handler: ToolHandler }> = [],
): { tools: ToolRegistry; kernel: Kernel } {
  const allowed = childToolAllowlist(requestedTools, config, parent_ctx.tools);
  const filtered = new FilteredToolRegistry(parent_ctx.tools, allowed);
  const tools: ToolRegistry =
    extra.length > 0 ? new ExtraToolsRegistry(filtered, extra) : filtered;
  const runtime = createToolRuntime({
    registry: tools,
    router: new ToolRouterImpl(),
    policy: parent_ctx.policy,
    approvals: parent_ctx.approvals,
  });
  return { tools, kernel: new ChildKernelView(parent_ctx.kernel, runtime) };
}

/** Wraps a session-scoped memory store into the child's isolated view. */
export function childMemory(parentMemory: MemoryStore, childSessionId: string): SubagentMemory {
  return new SubagentMemory(parentMemory, childSessionId);
}

/**
 * The per-subagent budget guard. Usage chunks are counted as they stream;
 * crossing the budget aborts the child controller exactly once. The child's
 * usage is also forwarded to the parent router (keyed by the child session
 * id) so per-session budget accounting stays correct.
 */
export class BudgetTrackingRouter implements ModelRouter {
  private used = 0;
  private tripped = false;

  constructor(
    private readonly inner: ModelRouter,
    private readonly budgetTokens: number,
    private readonly onExceeded: (used: number) => void,
  ) {}

  /** Tokens counted so far (tests + report evidence). */
  get tokensCounted(): number {
    return this.used;
  }

  /** True once the budget has been crossed. */
  get exceeded(): boolean {
    return this.tripped;
  }

  async *complete(req: CompletionRequest, opts?: RouteOptions): AsyncGenerator<ModelChunk, void, unknown> {
    for await (const chunk of this.inner.complete(req, opts)) {
      if (chunk.type === "usage") {
        this.used += usageTotal(chunk.usage);
        if (!this.tripped && this.used > this.budgetTokens) {
          this.tripped = true;
          this.onExceeded(this.used);
        }
      }
      yield chunk;
    }
  }

  listModels() {
    return this.inner.listModels();
  }

  recordUsage(session_id: string, usage: Usage): void {
    this.inner.recordUsage(session_id, usage);
  }

  checkBudget(session_id: string) {
    return this.inner.checkBudget(session_id);
  }
}

function usageTotal(usage: Usage): number {
  if (usage.total_tokens !== undefined) return usage.total_tokens;
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.reasoning_tokens ?? 0) +
    (usage.cache_read_tokens ?? 0)
  );
}

/** The child's prompt messages: sections come from the persona at loop time. */
export function childUserMessage(task: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `You are a subagent. Your task: ${task}. Complete it and give a final summary in your last message.`,
      },
    ],
  };
}

/** Re-exported type shortcut for the event pump the manager installs. */
export type { SessionEvent };
