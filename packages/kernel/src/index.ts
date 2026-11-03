// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/kernel — plugin lifecycle, capability enforcement, the priority hook
// bus, and the service registry. The kernel is the trust boundary: plugins
// only ever exercise what their manifest declares.

export { createKernel, KernelImpl } from "./kernel.js";
export type { KernelOptions } from "./kernel.js";
export { HookBusImpl } from "./hooks.js";
export type { HookScope } from "./hooks.js";
export { ServiceRegistryImpl, ToolRegistryImpl } from "./registry.js";
export {
  DuplicatePluginError,
  HookExecutionError,
  KernelClosedError,
  ManifestValidationError,
  MissingDependencyError,
  PluginInUseError,
  PluginTeardownError,
  PluginVersionError,
  ServiceNamespaceError,
  ToolOwnershipError,
  UnknownPluginError,
} from "./errors.js";
