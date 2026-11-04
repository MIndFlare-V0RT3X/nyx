// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/subagents — the Phase 3 subagent system: context-isolated child
// sessions with a narrowed tool registry, an isolated memory view, a
// sandbox that is FORKED per child by default (Phase 4: no implicit
// filesystem sharing — artifacts are the only handoff), and only the final
// summary + published artifacts crossing back to the parent.

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
// Phase 4 §4: the artifact handoff (fork mode).
export {
  ArtifactToolRegistry,
  SUBAGENT_ARTIFACT_TOOL,
  SUBAGENT_READ_ARTIFACT_TOOL,
  artifactNameOf,
  auditArtifactRead,
  auditArtifactWritten,
  lastWrittenHash,
  registerSubagentArtifactTools,
  subagentArtifactTool,
  type ArtifactWriteRecord,
} from "./artifacts.js";
