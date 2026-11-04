// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/subagents — the Phase 3 subagent system: context-isolated child
// sessions with a narrowed tool registry, an isolated memory view, a shared
// sandbox, and only the final summary crossing back to the parent.

export {
  SubagentError,
  type SubagentErrorCode,
} from "./errors.js";
export {
  DEFAULT_ALLOWED_TOOLS,
  DEFAULT_FORBIDDEN_TOOLS,
  DEFAULT_SUBAGENTS_CONFIG,
  resolveSubagentsConfig,
  type SubagentsConfig,
} from "./config.js";
export {
  ensureSubagentControlTable,
  requestSubagentAbort,
  listSubagentAbortRequests,
  deleteSubagentAbortRequest,
} from "./control.js";
export {
  BudgetTrackingRouter,
  ChildKernelView,
  FilteredToolRegistry,
  buildChildTooling,
  childMemory,
  childToolAllowlist,
  childUserMessage,
} from "./child-views.js";
export { SubagentMemory, SubagentMemoryError, SUBAGENT_READABLE_SCOPES } from "./memory-view.js";
export {
  SubagentManagerImpl,
  createSubagentManager,
  type BoundTurn,
  type SubagentManager,
  type SubagentManagerDeps,
} from "./manager.js";
export {
  SPAWN_SUBAGENT_INPUT_SCHEMA,
  SPAWN_SUBAGENT_TOOL,
  registerSubagentTool,
  type SpawnSubagentInput,
  type SubagentToolDeps,
} from "./tool.js";
