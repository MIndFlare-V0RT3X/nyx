// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/agent — the loop. One dependency-injected turn engine driven by every
// surface (server, CLI, SDK); tool execution arrives as a kernel service,
// everything else via RunContext. Runtime dependency: @nyx/protocol only.

export { AgentLoopImpl, createAgentLoop } from "./loop.js";
export { denialToolOutput, wrapToolOutput } from "./tool-runtime.js";
export type {
  ToolRuntimeExecuteContext,
  ToolRuntimeExecuteOptions,
  ToolRuntimeService,
} from "./tool-runtime.js";
export { AgentError } from "./errors.js";
export type { AgentErrorCode } from "./errors.js";
