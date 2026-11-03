// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ServiceRegistryImpl, ToolRegistryImpl } from "./registry.js";
import type { ToolDefinition, ToolHandler } from "@nyx/protocol";

const def = (name: string): ToolDefinition => ({
  name,
  description: "test",
  input_schema: { type: "object" },
  risk: "R0",
  capabilities: [],
  handler: `builtin:${name}`,
});

const handler: ToolHandler = {
  async execute() {
    return { kind: "text", text: "ok" };
  },
};

describe("ToolRegistryImpl", () => {
  it("registers, lists, gets, and unregisters", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("fs.read"), handler);
    expect(registry.list().map((d) => d.name)).toEqual(["fs.read"]);
    expect(registry.get("fs.read")?.handler).toBe(handler);
    expect(registry.get("nope")).toBeNull();
    registry.unregister("fs.read");
    expect(registry.list()).toEqual([]);
    expect(registry.get("fs.read")).toBeNull();
  });

  it("overwrites on re-registration of the same name", () => {
    const registry = new ToolRegistryImpl();
    registry.register(def("a"), handler);
    const replacement: ToolHandler = {
      async execute() {
        return { kind: "text", text: "replaced" };
      },
    };
    registry.register({ ...def("a"), description: "v2" }, replacement);
    expect(registry.list()).toHaveLength(1);
    expect(registry.get("a")?.def.description).toBe("v2");
    expect(registry.get("a")?.handler).toBe(replacement);
  });

  it("unregister of an unknown name is a no-op", () => {
    const registry = new ToolRegistryImpl();
    expect(() => registry.unregister("ghost")).not.toThrow();
  });
});

describe("ServiceRegistryImpl", () => {
  it("sets, gets, has, and deletes", () => {
    const services = new ServiceRegistryImpl();
    expect(services.get("x")).toBeUndefined();
    expect(services.has("x")).toBe(false);
    services.set("x", { value: 1 });
    expect(services.has("x")).toBe(true);
    expect(services.get<{ value: number }>("x")).toEqual({ value: 1 });
    services.delete("x");
    expect(services.has("x")).toBe(false);
  });

  it("deletePrefixed removes only matching names and returns the count", () => {
    const services = new ServiceRegistryImpl();
    services.set("plugin:a:one", 1);
    services.set("plugin:a:two", 2);
    services.set("plugin:b:one", 3);
    services.set("host:svc", 4);
    expect(services.deletePrefixed("plugin:a:")).toBe(2);
    expect(services.has("plugin:a:one")).toBe(false);
    expect(services.has("plugin:a:two")).toBe(false);
    expect(services.has("plugin:b:one")).toBe(true);
    expect(services.has("host:svc")).toBe(true);
    expect(services.deletePrefixed("plugin:a:")).toBe(0);
  });

  it("clear removes everything", () => {
    const services = new ServiceRegistryImpl();
    services.set("a", 1);
    services.set("b", 2);
    services.clear();
    expect(services.has("a")).toBe(false);
    expect(services.has("b")).toBe(false);
  });
});
