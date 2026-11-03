// SPDX-License-Identifier: AGPL-3.0-or-later
// The agent loop contract. One loop, dependency-injected, driven by every
// surface (server, CLI, SDK). No construction inside the loop body.

import type { Kernel } from "./kernel.js";
import type { SessionStore } from "./session.js";
import type { ModelRouter } from "./model.js";
import type { ToolRegistry, ToolRouter } from "./tools.js";
import type { PolicyEngine, ApprovalEngine } from "./policy.js";
import type { Sandbox } from "./sandbox.js";
import type { MemoryStore } from "./memory.js";
import type { PersonaRuntime } from "./persona.js";
import type { Logger } from "./util.js";
import type { SessionEvent } from "./events.js";
import type { Message } from "./content.js";

export interface RunInput {
  session_id: string;
  turn_id: string;
  user_message: Message;
}

export interface AgentOptions {
  /** Hard cap on model→tool round trips per turn. Default 12. */
  max_tool_rounds?: number;
  /** Token budget that triggers rule-based elision. Default 100000. */
  compaction_budget_tokens?: number;
}

export interface RunContext {
  kernel: Kernel;
  session: SessionStore;
  model: ModelRouter;
  tools: ToolRegistry;
  tool_router: ToolRouter;
  policy: PolicyEngine;
  approvals: ApprovalEngine;
  sandbox: Sandbox;
  memory: MemoryStore;
  persona: PersonaRuntime;
  signal: AbortSignal;
  logger: Logger;
  options?: AgentOptions;
}

export interface AgentLoop {
  /** Yields every session event the turn produces, in order, as it happens. */
  run(input: RunInput, ctx: RunContext): AsyncIterable<SessionEvent>;
}
