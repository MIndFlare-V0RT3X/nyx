// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { ToolRegistryImpl } from "./registry.js";

const handler: ToolHandler = {
  execute: vi.fn(async (): Promise<ToolOutput> => ({ kind: "text", text: "ok" })),
};

function def(name: string, risk: ToolDefinition["risk"] = "R0"): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    input_schema: { type: "object" },
    risk,
    capabilities: [],
    handler: `test:${name}`,
  };
}

describe("ToolRegistryImpl", () => {
  it("registers, lists in insertion order, and gets by name", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("fs.read"), handler);
    registry.register(def("shell.exec", "R3"), handler);

    expect(registry.list().map((d) => d.name)).toEqual(["fs.read", "shell.exec"]);
    const got = registry.get("fs.read");
    expect(got).not.toBeNull();
    expect(got?.def.risk).toBe("R0");
    expect(got?.handler).toBe(handler);
    expect(registry.get("shell.exec")?.def.risk).toBe("R3");
  });

  it("returns null for unknown names", () => {
    const registry = new ToolRegistryImpl();
    expect(registry.get("nope")).toBeNull();
    expect(registry.list()).toEqual([]);
  });

  it("rejects duplicate registration", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("fs.read"), handler);
    expect(() => registry.register(def("fs.read"), handler)).toThrowError(
      'tool "fs.read" is already registered',
    );
  });

  it("rejects definitions without a name", () => {
    const registry = new ToolRegistryImpl();
    const bad = def("x");
    (bad as { name: string }).name = "";
    expect(() => registry.register(bad, handler)).toThrowError("non-empty name");
  });

  it("unregister removes the tool and is a no-op for unknown names", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("fs.read"), handler);
    registry.unregister("fs.read");
    expect(registry.get("fs.read")).toBeNull();
    expect(registry.list()).toEqual([]);
    expect(() => registry.unregister("never-registered")).not.toThrow();
  });

  it("list() and get() return copies — callers cannot mutate registry state", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("fs.read"), handler);
    const listed = registry.list();
    listed[0]!.risk = "R4";
    listed[0]!.name = "hacked";
    expect(registry.get("fs.read")?.def.risk).toBe("R0");
    expect(registry.list().map((d) => d.name)).toEqual(["fs.read"]);
  });
});
