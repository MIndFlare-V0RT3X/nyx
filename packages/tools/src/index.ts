// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/tools — the tool runtime: registry, router, the enforcement pipeline,
// and the builtin tool set. Every ToolCall from the agent loop passes
// through createToolRuntime() before any handler runs.

export { ToolRegistryImpl } from "./registry.js";
export { ToolRouterImpl } from "./router.js";
export { registerBuiltinTools } from "./builtins.js";
export { builtinInputSchemas } from "./schemas.js";
export { createToolRuntime } from "./runtime.js";
export type {
  ToolExecContext,
  ToolRuntime,
  ToolRuntimeOptions,
  ToolRuntimeDeps,
} from "./runtime.js";
