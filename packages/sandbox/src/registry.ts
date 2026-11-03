// SPDX-License-Identifier: AGPL-3.0-or-later
// Provider registry: sandboxes are provisioned through named providers so
// callers (the kernel/tools runtime) never import a concrete provider.

import type { SandboxProvider } from "@nyx/protocol";
import { DockerSandboxProvider } from "./docker.js";
import { LocalSandboxProvider } from "./local.js";

export class SandboxProviders {
  private readonly providers = new Map<string, SandboxProvider>();

  /** Register a provider under its `id`. Chainable. */
  register(provider: SandboxProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`sandbox provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  get(id: string): SandboxProvider {
    const provider = this.providers.get(id);
    if (provider === undefined) {
      throw new Error(
        `unknown sandbox provider "${id}" (registered: ${this.list().join(", ") || "none"})`,
      );
    }
    return provider;
  }

  /** Registered provider ids. */
  list(): string[] {
    return [...this.providers.keys()].sort();
  }
}

/**
 * Default registry factory: a fresh registry pre-loaded with the built-in
 * providers — "local" (development only; refuses to provision when
 * NYX_ENV=production) and "docker" (network: none only).
 */
export function createDefaultSandboxRegistry(): SandboxProviders {
  return new SandboxProviders()
    .register(new LocalSandboxProvider())
    .register(new DockerSandboxProvider());
}
