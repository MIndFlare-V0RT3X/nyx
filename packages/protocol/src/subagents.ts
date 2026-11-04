// SPDX-License-Identifier: AGPL-3.0-or-later
// Subagent system types (Phase 3). A subagent is a child session with its own
// context window, a narrowed tool registry, an isolated memory view, and a
// shared sandbox. Only its final summary crosses back to the parent — as the
// spawn_subagent tool result. Types + boundary Zod schemas live here and in
// schemas.ts; the manager implementation lives in @nyx/subagents.

import type { SerializedError } from "./util.js";

/** sessions.kind — the three session lineages. */
export type SessionKind = "session" | "fork" | "subagent";

export interface SubagentSpec {
  /** Required, model-authored: the subtask. */
  task: string;
  /** Optional tool allowlist (subset of the parent's tools). Defaults to config. */
  tools?: string[];
  /** Optional model override (router chain step id). */
  model?: string;
  /** Optional per-subagent token budget. Clamped to config.subagents.max_budget_tokens. */
  budget_tokens?: number;
  /**
   * Optional depth override — may only TIGHTEN (lower) the configured
   * max_depth, never loosen it. A value above config is clamped down.
   */
  max_depth_override?: number;
}

export type SubagentState = "running" | "completed" | "failed" | "aborted" | "budget_exceeded";

export interface SubagentResult {
  /** The subagent's session (persisted, auditable, replayable). */
  session_id: string;
  /** The subagent's final assistant message text. */
  summary: string;
  state: "completed" | "failed" | "aborted" | "budget_exceeded";
  tokens_used: number;
  duration_ms: number;
  /** Set if state !== "completed". */
  error?: SerializedError;
}

export interface SubagentInfo {
  session_id: string;
  parent_session_id: string;
  parent_turn_id: string;
  spawned_at: number;
  state: SubagentState;
  /** Truncated task text. */
  task: string;
}
