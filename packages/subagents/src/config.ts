// SPDX-License-Identifier: AGPL-3.0-or-later
// The subagents section of nyx.config.yaml, as a runtime type with code
// defaults. The Zod schema that parses the YAML lives in @nyx/config
// (schema.ts) and produces the same shape; surfaces pass the parsed section
// in and TypeScript checks structural compatibility at the wiring point.

export interface SubagentsConfig {
  /** Max subagent lineage depth. 0 = no spawning at all. Default 3. */
  max_depth: number;
  /** Token budget across ALL subagents of one parent turn. Default 200000. */
  max_total_per_turn: number;
  /** Per-subagent budget when a spec doesn't name one. Default 32768. */
  default_budget_tokens: number;
  /** Per-subagent ceiling — a spec may request less, never more. Default 65536. */
  max_budget_tokens: number;
  /** Tool allowlist when a spec doesn't name one. */
  default_allowed_tools: string[];
  /** Always blocked, cannot be overridden by any allowlist. */
  forbidden_tools: string[];
  /** "inherit" (shared with parent — Phase 3) | "fork" (Phase 4+). */
  sandbox_sharing: "inherit" | "fork";
  /** Phase 4 GC knob: subagent sessions older than this are collected. Default 7. */
  retention_days: number;
}

/** The default_allowed_tools list per the Phase 3 brief (§2.6). */
export const DEFAULT_ALLOWED_TOOLS: readonly string[] = [
  "fs.read",
  "fs.write",
  "fs.list",
  "shell.exec",
  "web.fetch",
];

/** Tools no subagent may ever see. spawn_subagent is structural, not config. */
export const DEFAULT_FORBIDDEN_TOOLS: readonly string[] = [
  "spawn_subagent",
  "spawn_subagent_v2",
];

export const DEFAULT_SUBAGENTS_CONFIG: SubagentsConfig = {
  max_depth: 3,
  max_total_per_turn: 200_000,
  default_budget_tokens: 32_768,
  max_budget_tokens: 65_536,
  default_allowed_tools: [...DEFAULT_ALLOWED_TOOLS],
  forbidden_tools: [...DEFAULT_FORBIDDEN_TOOLS],
  sandbox_sharing: "inherit",
  retention_days: 7,
};

/** Merge a partial config section over the defaults. */
export function resolveSubagentsConfig(partial?: Partial<SubagentsConfig>): SubagentsConfig {
  return {
    ...DEFAULT_SUBAGENTS_CONFIG,
    ...(partial ?? {}),
    default_allowed_tools: [...(partial?.default_allowed_tools ?? DEFAULT_ALLOWED_TOOLS)],
    forbidden_tools: [...(partial?.forbidden_tools ?? DEFAULT_FORBIDDEN_TOOLS)],
  };
}
