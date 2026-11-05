// SPDX-License-Identifier: AGPL-3.0-or-later
// Tool system types: definitions, calls, outputs, runtime context, registry, router.

import type { JsonSchema, Logger } from "./util.js";
import type { SessionEvent } from "./events.js";
import type { Engagement } from "./scope.js";
import type { Sandbox } from "./sandbox.js";

export type RiskTier = "R0" | "R1" | "R2" | "R3" | "R4";

export type Capability =
  | "fs.read"
  | "fs.write"
  | "fs.delete"
  | "proc.spawn"
  | "proc.kill"
  | "net.egress"
  | "net.listen"
  /** Phase 6.3: fixed-host research egress (CVE databases) — NOT engagement
   *  targets; the hosts are pinned in code, queries audit-logged. */
  | "net.reference"
  | "browser.control"
  | "desktop.control"
  | "credential.use"
  | "host.access"
  | "git.push"
  | "deploy";

export interface ToolDefinition {
  /** Dotted name, e.g. "fs.read". */
  name: string;
  /** Model-facing description. */
  description: string;
  input_schema: JsonSchema;
  risk: RiskTier;
  capabilities: Capability[];
  /** Handler locator: "builtin:fs.read" | "mcp:<server>/<tool>" | "plugin:<name>/<tool>". */
  handler: string;
  timeout_ms?: number;
  concurrency?: "serial" | "parallel";
}

export interface ToolCall {
  call_id: string;
  name: string;
  input: unknown;
}

export type ToolOutput =
  | { kind: "text"; text: string }
  | { kind: "json"; json: unknown }
  | { kind: "file"; path: string; bytes: number; mime: string }
  | { kind: "artifact"; artifact_id: string; path: string; bytes: number };

/**
 * Everything a handler receives. Handlers never touch the host: `sandbox` is
 * their only route to the outside world, `emit` is their only route to the
 * event log, and `engagement` carries the session's immutable scope (used by
 * the runtime, not usually by handlers).
 */
export interface ToolContext {
  session_id: string;
  turn_id: string;
  call_id: string;
  sandbox: Sandbox;
  signal: AbortSignal;
  logger: Logger;
  emit: (e: SessionEvent) => void;
  engagement: Engagement | null;
}

export interface ToolHandler {
  execute(call: ToolCall, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolRegistry {
  register(def: ToolDefinition, handler: ToolHandler): void;
  unregister(name: string): void;
  list(): ToolDefinition[];
  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null;
}

export interface ToolRouter {
  /** Returns the definition to execute, or null when the name is unknown. */
  select(call: ToolCall, available: ToolDefinition[]): ToolDefinition | null;
}
