// SPDX-License-Identifier: AGPL-3.0-or-later
// The spawn_subagent tool (Phase 3 §2.3). Registered on the tool registry at
// kernel setup — but ONLY when max_depth >= 1 (max_depth 0 means no spawning
// at all, and the model never sees the tool). Subagent sessions never get it:
// their registries are FilteredToolRegistry views that reject the name
// structurally, so a subagent's spawn attempt is a clean "unknown tool".
//
// The handler resolves the parent's RunContext through the manager's
// per-turn binding (the surface binds at turn start, unbinds at turn end —
// the lane queue guarantees one active turn per session) and routes to
// SubagentManager.spawn. The SubagentResult comes back to the model as the
// tool.result JSON.

import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput, ToolRegistry } from "@nyx/protocol";
import type { SubagentManager } from "./manager.js";
import type { SubagentsConfig } from "./config.js";
import { SubagentError } from "./errors.js";

/** Wall clock for one spawn: subagents may legitimately run for minutes. */
const SPAWN_TIMEOUT_MS = 600_000;

export const SPAWN_SUBAGENT_TOOL = "spawn_subagent";

/** The model-facing input schema — the brief's §2.3 shape, verbatim. */
export const SPAWN_SUBAGENT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    task: { type: "string", description: "The subtask. Be specific." },
    tools: {
      type: "array",
      items: { type: "string" },
      description: "Optional tool allowlist (subset of your tools).",
    },
    budget_tokens: {
      type: "integer",
      minimum: 1024,
      description: "Optional token budget.",
    },
  },
  required: ["task"],
} as const;

export interface SpawnSubagentInput {
  task: string;
  tools?: string[];
  budget_tokens?: number;
}

export interface SubagentToolDeps {
  manager: SubagentManager;
  config: SubagentsConfig;
}

function isSpawnInput(value: unknown): value is SpawnSubagentInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.task !== "string" || v.task.length === 0) return false;
  if (v.tools !== undefined && (!Array.isArray(v.tools) || v.tools.some((t) => typeof t !== "string"))) {
    return false;
  }
  if (
    v.budget_tokens !== undefined &&
    (typeof v.budget_tokens !== "number" || !Number.isInteger(v.budget_tokens))
  ) {
    return false;
  }
  return true;
}

/**
 * Registers spawn_subagent. A no-op when config.subagents.max_depth is 0 —
 * "0 = no spawning at all" is enforced by the tool's absence, not by a
 * runtime check the model could probe.
 */
export function registerSubagentTool(registry: ToolRegistry, deps: SubagentToolDeps): void {
  if (deps.config.max_depth === 0) return;

  const def: ToolDefinition = {
    name: SPAWN_SUBAGENT_TOOL,
    description:
      "Spawn a subagent to work on a focused subtask. The subagent has " +
      "its own context window and returns only its final summary. Use it for " +
      "parallel research, isolated experimentation, or narrowing scope. Multiple " +
      "calls in one round run in parallel.",
    input_schema: SPAWN_SUBAGENT_INPUT_SCHEMA,
    // No external side effects of its own; the subagent inherits the parent's
    // risk posture through the shared policy engine (§2.3).
    risk: "R1",
    capabilities: [],
    handler: "builtin:spawn_subagent",
    concurrency: "parallel",
    timeout_ms: SPAWN_TIMEOUT_MS,
  };

  const handler: ToolHandler = {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      if (!isSpawnInput(call.input)) {
        throw new SubagentError(
          "validation_failed",
          "spawn_subagent input must be {task: string, tools?: string[], budget_tokens?: integer}",
        );
      }
      const bound = deps.manager.boundTurn(ctx.session_id, ctx.turn_id);
      if (bound === undefined) {
        throw new SubagentError(
          "no_parent_context",
          `spawn_subagent: no bound turn context for session ${ctx.session_id} turn ${ctx.turn_id}`,
        );
      }
      const result = await deps.manager.spawn(
        {
          task: call.input.task,
          ...(call.input.tools !== undefined ? { tools: call.input.tools } : {}),
          ...(call.input.budget_tokens !== undefined
            ? { budget_tokens: call.input.budget_tokens }
            : {}),
        },
        bound.ctx,
        { session_id: ctx.session_id, turn_id: ctx.turn_id },
      );
      return { kind: "json", json: result };
    },
  };

  registry.register(def, handler);
}
