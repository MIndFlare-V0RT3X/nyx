// SPDX-License-Identifier: AGPL-3.0-or-later
// Kernel contracts: plugins declare capabilities and are enforced against them.

import type { Capability } from "./tools.js";
import type { ToolRegistry } from "./tools.js";
import type { HookBus, HookName } from "./hooks.js";
import type { ServiceRegistry } from "./util.js";

export interface PluginManifest {
  name: string;
  version: string;
  /** Semver range of the kernel API this plugin was built against. */
  nyx: string;
  /** Declared capabilities; enforced against actual calls. */
  capabilities: Capability[];
  /** Other plugin names this plugin must be set up after. */
  dependencies?: string[];
  hooks?: HookName[];
  tools?: string[];
  permissions?: { fs?: string[]; net?: string[] };
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
