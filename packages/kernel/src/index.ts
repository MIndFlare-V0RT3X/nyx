// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/kernel — plugin lifecycle, capability enforcement, the priority hook
// bus, and the service registry. The kernel is the trust boundary: plugins
// only ever exercise what their manifest declares.
//
// Phase 7.2 adds: manifest v2 (versioned dependencies, index.js integrity,
// optional Ed25519 signature), the third-party plugin loader with the
// strict/warn/off signature gate, trusted-keys handling, host-only plugin-set
// mutation (R3-14 closure), and the capability audit (list_plugins()).

export { createKernel, KernelImpl } from "./kernel.js";
export type { KernelOptions } from "./kernel.js";
export { HookBusImpl } from "./hooks.js";
export type { HookScope } from "./hooks.js";
export { ServiceRegistryImpl, ToolRegistryImpl } from "./registry.js";
export {
  DependencyVersionError,
  DuplicatePluginError,
  HookExecutionError,
  KernelClosedError,
  ManifestValidationError,
  MissingDependencyError,
  PluginInUseError,
  PluginIntegrityError,
  PluginMutationError,
  PluginSignatureError,
  PluginTeardownError,
  PluginVersionError,
  ServiceNamespaceError,
  ToolOwnershipError,
  UnknownPluginError,
} from "./errors.js";
export { pluginManifestSchema, v1MigrationHints, manifestIssues, HOOK_NAMES } from "./manifest.js";
export type { ParsedPluginManifest } from "./manifest.js";
export { loadPluginDirectory, resolveSignatureMode } from "./loader.js";
export type { SignatureMode, LoadPluginOptions, LoadedPluginModule } from "./loader.js";
export {
  checkManifestSignature,
  generateSigningKeypair,
  loadTrustedKeys,
  sha256Hex,
  signManifest,
  canonicalManifestForSigning,
} from "./signature.js";
export type { TrustedKeysFile, GeneratedKeypair, SignatureCheck } from "./signature.js";
