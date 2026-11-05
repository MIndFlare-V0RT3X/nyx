// SPDX-License-Identifier: AGPL-3.0-or-later
// Kernel contracts: plugins declare capabilities and are enforced against them.
//
// Phase 7.2 — the manifest contract moves to v2: dependencies carry version
// ranges, `integrity` pins the plugin's index.js (sha256), and an optional
// Ed25519 `signature` over the canonical manifest anchors third-party
// plugins to the operator's trusted-keys file. v1 manifests are rejected
// with a migration message (the kernel is the only validator).

import type { Capability } from "./tools.js";
import type { ToolRegistry } from "./tools.js";
import type { HookBus, HookName } from "./hooks.js";
import type { ServiceRegistry } from "./util.js";

/** A dependency on another plugin, with the accepted version range. */
export interface PluginDependency {
  name: string;
  /** Semver range the loaded dependency's version must satisfy. */
  version_range: string;
}

/** Ed25519 signature over the canonical manifest JSON (signature removed). */
export interface PluginSignature {
  /** Hex-encoded Ed25519 public key — must appear in trusted-keys.json. */
  public_key: string;
  /** Hex-encoded Ed25519 signature. */
  signature: string;
}

export interface PluginManifest {
  /** Manifest format discriminator. v1 manifests (no field) are rejected. */
  manifest_version: 2;
  name: string;
  version: string;
  /** Semver range of the kernel API this plugin was built against. */
  nyx: string;
  /** Declared capabilities; enforced against actual calls. */
  capabilities: Capability[];
  /** Other plugins this plugin must be set up after, with version ranges. */
  dependencies?: PluginDependency[];
  /** sha256 (hex) of the plugin's index.js — verified at load time. */
  integrity: string;
  /** Sibling code files (index.js's imports) → their sha256 hex. The loader
   *  refuses any on-disk code file that is not listed-and-hashed (R2-2). */
  files?: Record<string, string>;
  /** Optional Ed25519 signature; required in `strict` signature mode. */
  signature?: PluginSignature;
  hooks?: HookName[];
  tools?: string[];
  permissions?: { fs?: string[]; net?: string[] };
}

/** One plugin's capability audit record (kernel.list_plugins()). */
export interface PluginAuditRecord {
  name: string;
  version: string;
  nyx: string;
  capabilities: {
    declared: Capability[];
    used: Capability[];
  };
  dependencies?: PluginDependency[];
  /** Over-declared capabilities and any other audit warnings. */
  warnings: string[];
}

export interface Plugin {
  manifest: PluginManifest;
  setup(kernel: Kernel): Promise<void> | void;
  teardown?(): Promise<void> | void;
}

export interface Kernel {
  use(plugin: Plugin): Promise<void>;
  unuse(name: string): Promise<void>;
  hooks: HookBus;
  tools: ToolRegistry;
  services: ServiceRegistry;
  version: string;
  /** Capability audit records for every loaded plugin (Phase 7.2).
   *  Optional so per-turn kernel views can pass through unchanged. */
  list_plugins?(): PluginAuditRecord[];
}

/** Thrown when a plugin exercises a capability it did not declare. */
export class CapabilityError extends Error {
  code = "capability" as const;
  constructor(
    public readonly plugin: string,
    public readonly capability: Capability,
  ) {
    super(`plugin "${plugin}" exercised capability "${capability}" it did not declare`);
    this.name = "CapabilityError";
  }
}
