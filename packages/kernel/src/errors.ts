// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed kernel errors. Every outcome a caller must distinguish gets its own
// class with a stable machine-readable `code`. Codes that exist in
// @nyx/protocol's NyxErrorCode set reuse it ("validation_failed"); the rest
// are kernel-lifecycle codes local to this package.

import type { HookName } from "@nyx/protocol";

/** Manifest failed schema validation (unknown keys, bad types, bad values). */
export class ManifestValidationError extends Error {
  readonly code = "validation_failed" as const;
  readonly plugin: string;
  readonly issues: string[];

  constructor(plugin: string, issues: string[]) {
    super(`invalid manifest for plugin "${plugin}": ${issues.join("; ")}`);
    this.name = "ManifestValidationError";
    this.plugin = plugin;
    this.issues = issues;
  }
}

/** Plugin's `nyx` range is not satisfied by the running kernel version. */
export class PluginVersionError extends Error {
  readonly code = "plugin_incompatible" as const;
  readonly plugin: string;
  readonly range: string;
  readonly kernelVersion: string;

  constructor(plugin: string, range: string, kernelVersion: string) {
    super(
      `plugin "${plugin}" declares nyx range "${range}" which is not satisfied by kernel version ${kernelVersion}`,
    );
    this.name = "PluginVersionError";
    this.plugin = plugin;
    this.range = range;
    this.kernelVersion = kernelVersion;
  }
}

/** Plugin declares dependencies that are not loaded; load dependencies first. */
export class MissingDependencyError extends Error {
  readonly code = "dependency_missing" as const;
  readonly plugin: string;
  readonly missing: string[];

  constructor(plugin: string, missing: string[]) {
    super(
      `plugin "${plugin}" declares dependencies that are not loaded: ${missing
        .map((d) => `"${d}"`)
        .join(", ")}; use dependencies before dependents`,
    );
    this.name = "MissingDependencyError";
    this.plugin = plugin;
    this.missing = missing;
  }
}

/** A loaded dependency's version does not satisfy the declared range. */
export class DependencyVersionError extends Error {
  readonly code = "dependency_version" as const;
  readonly plugin: string;
  readonly mismatches: { name: string; loaded: string; range: string }[];

  constructor(
    plugin: string,
    mismatches: { name: string; loaded: string; range: string }[],
  ) {
    super(
      `plugin "${plugin}" has dependencies whose loaded versions miss the declared ranges: ${mismatches
        .map((m) => `"${m.name}" ${m.loaded} !~ ${m.range}`)
        .join(", ")}`,
    );
    this.name = "DependencyVersionError";
    this.plugin = plugin;
    this.mismatches = mismatches;
  }
}

/**
 * Plugin code tried to mutate the plugin set (use/unuse) — Phase 7.2's
 * structural closure of the re-registration class (R3-14): only host code
 * may load or unload plugins. A plugin that could unuse() a neighbor could
 * free its tool names and hijack them; now the attempt refuses here.
 */
export class PluginMutationError extends Error {
  readonly code = "plugin_mutation" as const;
  readonly plugin: string;
  readonly action: "use" | "unuse";

  constructor(plugin: string, action: "use" | "unuse") {
    super(
      `plugin "${plugin}" cannot call kernel.${action}(): the plugin set is host-only mutable (R3-14 closure)`,
    );
    this.name = "PluginMutationError";
    this.plugin = plugin;
    this.action = action;
  }
}

/**
 * A plugin from disk failed its signature gate: unsigned in strict mode, a
 * bad signature, or signed by a key absent from trusted-keys.json (rejected
 * even in warn mode — a signature is an anchor claim, not a decoration).
 */
export class PluginSignatureError extends Error {
  readonly code = "plugin_signature" as const;
  readonly plugin: string;
  readonly reason: "unsigned" | "untrusted_key" | "invalid_signature" | "malformed";

  constructor(plugin: string, reason: PluginSignatureError["reason"], detail: string) {
    super(`plugin "${plugin}" failed signature verification (${reason}): ${detail}`);
    this.name = "PluginSignatureError";
    this.plugin = plugin;
    this.reason = reason;
  }
}

/** The on-disk index.js does not match the manifest's `integrity` sha256. */
export class PluginIntegrityError extends Error {
  readonly code = "plugin_integrity" as const;
  readonly plugin: string;
  readonly declared: string;
  readonly actual: string;

  constructor(plugin: string, declared: string, actual: string) {
    super(
      `plugin "${plugin}" integrity mismatch: manifest declares sha256 ${declared} but index.js hashes to ${actual}`,
    );
    this.name = "PluginIntegrityError";
    this.plugin = plugin;
    this.declared = declared;
    this.actual = actual;
  }
}

/** A plugin with the same name is already loaded. */
export class DuplicatePluginError extends Error {
  readonly code = "plugin_duplicate" as const;
  readonly plugin: string;

  constructor(plugin: string) {
    super(`plugin "${plugin}" is already loaded`);
    this.name = "DuplicatePluginError";
    this.plugin = plugin;
  }
}

/** unuse() was called for a name that is not a loaded plugin. */
export class UnknownPluginError extends Error {
  readonly code = "plugin_unknown" as const;
  readonly plugin: string;

  constructor(plugin: string) {
    super(`no loaded plugin named "${plugin}"`);
    this.name = "UnknownPluginError";
    this.plugin = plugin;
  }
}

/** unuse() was blocked because another loaded plugin depends on this one. */
export class PluginInUseError extends Error {
  readonly code = "plugin_in_use" as const;
  readonly plugin: string;
  readonly dependents: string[];

  constructor(plugin: string, dependents: string[]) {
    super(
      `plugin "${plugin}" cannot be unused while loaded plugin(s) depend on it: ${dependents
        .map((d) => `"${d}"`)
        .join(", ")}`,
    );
    this.name = "PluginInUseError";
    this.plugin = plugin;
    this.dependents = dependents;
  }
}

/** A hook callback threw; the original error is preserved as `cause`. */
export class HookExecutionError extends Error {
  readonly code = "hook_failed" as const;
  readonly hook: HookName;
  /** Owning plugin name, or null when the hook was registered by host code. */
  readonly plugin: string | null;

  constructor(hook: HookName, plugin: string | null, cause: unknown) {
    const owner = plugin === null ? "host" : `plugin "${plugin}"`;
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`hook "${hook}" (${owner}) failed: ${causeMessage}`, { cause });
    this.name = "HookExecutionError";
    this.hook = hook;
    this.plugin = plugin;
  }
}

/** A plugin touched a service outside its `plugin:<name>:` namespace. */
export class ServiceNamespaceError extends Error {
  readonly code = "service_namespace" as const;
  readonly plugin: string;
  readonly service: string;

  constructor(plugin: string, service: string, action: "set" | "delete") {
    super(
      `plugin "${plugin}" may only ${action} services under "plugin:${plugin}:" but attempted "${service}"`,
    );
    this.name = "ServiceNamespaceError";
    this.plugin = plugin;
    this.service = service;
  }
}

/** A plugin tried to unregister/re-register a tool it does not own. */
export class ToolOwnershipError extends Error {
  readonly code = "tool_ownership" as const;
  readonly plugin: string;
  readonly tool: string;
  readonly owner: string | null;

  constructor(
    plugin: string,
    tool: string,
    owner: string | null,
    action: "register" | "unregister",
  ) {
    const ownerDesc = owner === null ? "host" : `"${owner}"`;
    super(`plugin "${plugin}" cannot ${action} tool "${tool}" owned by ${ownerDesc}`);
    this.name = "ToolOwnershipError";
    this.plugin = plugin;
    this.tool = tool;
    this.owner = owner;
  }
}

/** A plugin's teardown threw; the original error is preserved as `cause`. */
export class PluginTeardownError extends Error {
  readonly code = "plugin_teardown" as const;
  readonly plugin: string;

  constructor(plugin: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`teardown of plugin "${plugin}" failed: ${causeMessage}`, { cause });
    this.name = "PluginTeardownError";
    this.plugin = plugin;
  }
}

/** Lifecycle method called after close(). */
export class KernelClosedError extends Error {
  readonly code = "closed" as const;

  constructor(operation: string) {
    super(`kernel is closed: cannot ${operation}()`);
    this.name = "KernelClosedError";
  }
}
