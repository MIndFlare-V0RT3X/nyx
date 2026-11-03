// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain registry implementations. The kernel wraps these with capability and
// namespace enforcement; they are exported for hosts that want to supply their
// own backing tool registry to createKernel().

import type { ServiceRegistry, ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";

export class ToolRegistryImpl implements ToolRegistry {
  #tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  register(def: ToolDefinition, handler: ToolHandler): void {
    this.#tools.set(def.name, { def, handler });
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  list(): ToolDefinition[] {
    return [...this.#tools.values()].map((entry) => entry.def);
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    return this.#tools.get(name) ?? null;
  }
}

export class ServiceRegistryImpl implements ServiceRegistry {
  #services = new Map<string, unknown>();

  get<T>(name: string): T | undefined {
    return this.#services.get(name) as T | undefined;
  }

  set(name: string, service: unknown): void {
    this.#services.set(name, service);
  }

  has(name: string): boolean {
    return this.#services.has(name);
  }

  delete(name: string): void {
    this.#services.delete(name);
  }

  /** Remove every service whose name starts with `prefix` (plugin unload). */
  deletePrefixed(prefix: string): number {
    let removed = 0;
    for (const key of [...this.#services.keys()]) {
      if (key.startsWith(prefix)) {
        this.#services.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.#services.clear();
  }
}
