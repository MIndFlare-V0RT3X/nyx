// SPDX-License-Identifier: AGPL-3.0-or-later
// Map-backed tool registry. Registration order is preserved (Map iteration),
// which makes `list()` and the model-facing tool catalog deterministic.

import type { ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, { def: ToolDefinition; handler: ToolHandler }>();

  register(def: ToolDefinition, handler: ToolHandler): void {
    if (typeof def.name !== "string" || def.name === "") {
      throw new Error("tool definition requires a non-empty name");
    }
    if (this.tools.has(def.name)) {
      throw new Error(`tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, { def, handler });
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Registered definitions, in registration order. Returns copies. */
  list(): ToolDefinition[] {
    return [...this.tools.values()].map((entry) => ({ ...entry.def }));
  }

  get(name: string): { def: ToolDefinition; handler: ToolHandler } | null {
    const entry = this.tools.get(name);
    if (entry === undefined) return null;
    return { def: { ...entry.def }, handler: entry.handler };
  }
}
