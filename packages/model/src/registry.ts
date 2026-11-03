// SPDX-License-Identifier: AGPL-3.0-or-later
// Map-backed provider registry. Deliberately unopinionated: any provider id
// can be registered, any base URL is allowed — there is no host allowlist
// and no URL restriction of any kind in this package.

import type { ModelProvider, ProviderRegistry } from "@nyx/protocol";

export class ProviderRegistryImpl implements ProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider | undefined {
    return this.providers.get(id);
  }

  list(): ModelProvider[] {
    return [...this.providers.values()];
  }
}
