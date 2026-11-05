// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 7.2 — the kernel lifecycle suite (use/unuse/close, manifest v2
// enforcement, dependency version ranges, the R3-14 plugin-set mutation
// refusal, capability enforcement + audit). Direct-handler tests live here;
// the paired runtime-wrapper tests (loadPluginDirectory → use) are in
// loader.test.ts — Phase 7 §0.1's two-layer discipline.

import { describe, expect, it } from "vitest";
import type { Plugin, PluginManifest, ToolDefinition, ToolHandler } from "@nyx/protocol";
import {
  createKernel,
  PluginVersionError,
} from "./index.js";

const INTEGRITY = "0".repeat(64);

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    manifest_version: 2,
    name: "test-plugin",
    version: "1.0.0",
    nyx: ">=0.1.0",
    capabilities: [],
    integrity: INTEGRITY,
    ...overrides,
  };
}

function plugin(overrides: Partial<PluginManifest> = {}): Plugin {
  const m = manifest(overrides);
  return { manifest: m, setup: () => undefined };
}

function helloTool(): { def: ToolDefinition; handler: ToolHandler } {
  return {
    def: {
      name: "plugin-tool",
      description: "test tool",
      input_schema: { type: "object", properties: {} },
      risk: "R0",
      capabilities: [],
      handler: "plugin:test-plugin/plugin-tool",
    },
    handler: { execute: async () => ({ kind: "text", text: "hi" }) },
  };
}

describe("kernel.use — manifest v2", () => {
  it("loads a valid v2 plugin and tracks it", async () => {
    const kernel = createKernel();
    await kernel.use(plugin());
    expect(kernel.list_plugins().map((p) => p.name)).toEqual(["test-plugin"]);
  });

  it("rejects a v1 manifest with a migration message", async () => {
    const kernel = createKernel();
    const legacyManifest = {
      // no manifest_version, string dependencies, no integrity — v1 shape
      name: "legacy",
      version: "1.0.0",
      nyx: ">=0.1.0",
      capabilities: [],
      dependencies: ["other"],
    };
    const legacy = { manifest: legacyManifest, setup: () => undefined } as unknown as Plugin;
    await expect(kernel.use(legacy)).rejects.toMatchObject({
      name: "ManifestValidationError",
      issues: expect.arrayContaining([expect.stringContaining("v1→v2 migration")]),
    });
  });

  it("refuses an out-of-range nyx", async () => {
    const kernel = createKernel();
    await expect(kernel.use(plugin({ nyx: ">=99.0.0" }))).rejects.toBeInstanceOf(
      PluginVersionError,
    );
  });
});

describe("kernel.use — dependencies (v2: names + version ranges)", () => {
  it("refuses a missing dependency", async () => {
    const kernel = createKernel();
    await expect(
      kernel.use(plugin({ dependencies: [{ name: "absent", version_range: ">=1.0.0" }] })),
    ).rejects.toMatchObject({ name: "MissingDependencyError", missing: ["absent"] });
  });

  it("refuses a loaded dependency whose version misses the range", async () => {
    const kernel = createKernel();
    await kernel.use(plugin({ name: "dep", version: "1.2.0" }));
    await expect(
      kernel.use(
        plugin({
          name: "dependent",
          dependencies: [{ name: "dep", version_range: ">=2.0.0" }],
        }),
      ),
    ).rejects.toMatchObject({
      name: "DependencyVersionError",
      mismatches: [{ name: "dep", loaded: "1.2.0", range: ">=2.0.0" }],
    });
  });

  it("accepts a dependency inside the range and guards unuse via dependents", async () => {
    const kernel = createKernel();
    await kernel.use(plugin({ name: "dep", version: "1.2.0" }));
    await kernel.use(
      plugin({
        name: "dependent",
        dependencies: [{ name: "dep", version_range: "^1.0.0" }],
      }),
    );
    await expect(kernel.unuse("dep")).rejects.toMatchObject({
      name: "PluginInUseError",
      dependents: ["dependent"],
    });
  });
});

describe("kernel.use — R3-14: the plugin set is host-only mutable", () => {
  it("refuses a plugin calling kernel.use(self) during its own setup", async () => {
    const kernel = createKernel();
    const selfLoader: Plugin = {
      manifest: manifest({ name: "self-loader" }),
      setup: async (k) => {
        await k.use(selfLoader);
      },
    };
    await expect(kernel.use(selfLoader)).rejects.toMatchObject({
      name: "PluginMutationError",
      code: "plugin_mutation",
      plugin: "self-loader",
      action: "use",
    });
    // And nothing half-registered survived.
    expect(kernel.list_plugins()).toEqual([]);
  });

  it("refuses a plugin calling kernel.use(otherPlugin)", async () => {
    const kernel = createKernel();
    let victim: Plugin = plugin({ name: "victim" });
    const attacker: Plugin = {
      manifest: manifest({ name: "attacker" }),
      setup: async (k) => {
        await k.use(victim);
      },
    };
    victim = plugin({ name: "victim" });
    await expect(kernel.use(attacker)).rejects.toMatchObject({
      name: "PluginMutationError",
      plugin: "attacker",
    });
  });

  it("refuses a plugin unusing a neighbor (the tool-name hijack vector)", async () => {
    const kernel = createKernel();
    await kernel.use({
      manifest: manifest({ name: "neighbor" }),
      setup: async (k) => {
        const { def, handler } = helloTool();
        def.name = "neighbor-tool";
        k.tools.register(def, handler);
      },
    });
    const hijacker: Plugin = {
      manifest: manifest({ name: "hijacker" }),
      setup: async (k) => {
        await k.unuse("neighbor");
        // …and would then register its own handler under "neighbor-tool".
      },
    };
    await expect(kernel.use(hijacker)).rejects.toMatchObject({
      name: "PluginMutationError",
      action: "unuse",
      plugin: "hijacker",
    });
    // The neighbor and its tool survived the failed hijack.
    expect(kernel.list_plugins().map((p) => p.name)).toEqual(["neighbor"]);
    expect(kernel.tools.get("neighbor-tool")).toBeDefined();
  });

  it("refuses a plugin re-registering an already-loaded name (host re-use also refuses)", async () => {
    const kernel = createKernel();
    await kernel.use(plugin());
    await expect(kernel.use(plugin())).rejects.toMatchObject({
      name: "DuplicatePluginError",
      plugin: "test-plugin",
    });
  });

  it("host code may still use/unuse freely", async () => {
    const kernel = createKernel();
    await kernel.use(plugin({ name: "one" }));
    await kernel.use(plugin({ name: "two" }));
    await kernel.unuse("one");
    expect(kernel.list_plugins().map((p) => p.name)).toEqual(["two"]);
  });
});

describe("capability enforcement + audit (Phase 7.2)", () => {
  it("throws CapabilityError for an undeclared capability on tool registration", async () => {
    const kernel = createKernel();
    const evil: Plugin = {
      manifest: manifest({ name: "evil", capabilities: ["fs.read"] }),
      setup: (k) => {
        const { def, handler } = helloTool();
        def.capabilities = ["net.egress"];
        k.tools.register(def, handler);
      },
    };
    await expect(kernel.use(evil)).rejects.toMatchObject({
      name: "CapabilityError",
      code: "capability",
      plugin: "evil",
      capability: "net.egress",
    });
  });

  it("warns on over-declaration via list_plugins()", async () => {
    const kernel = createKernel();
    await kernel.use({
      manifest: manifest({ name: "bloated", capabilities: ["fs.read", "net.egress"] }),
      setup: (k) => {
        const { def, handler } = helloTool();
        def.capabilities = ["fs.read"]; // uses only fs.read
        k.tools.register(def, handler);
      },
    });
    const records = kernel.list_plugins();
    expect(records).toHaveLength(1);
    expect(records[0]?.capabilities).toEqual({ declared: ["fs.read", "net.egress"], used: ["fs.read"] });
    expect(records[0]?.warnings).toHaveLength(1);
    expect(records[0]?.warnings[0]).toContain("net.egress");
    // After unuse, the record (and its warning) is gone.
    await kernel.unuse("bloated");
    expect(kernel.list_plugins()).toEqual([]);
  });

  it("no warning when declared == used", async () => {
    const kernel = createKernel();
    await kernel.use({
      manifest: manifest({ name: "exact", capabilities: ["fs.read"] }),
      setup: (k) => {
        const { def, handler } = helloTool();
        def.capabilities = ["fs.read"];
        k.tools.register(def, handler);
      },
    });
    expect(kernel.list_plugins()[0]?.warnings).toEqual([]);
    expect(kernel.list_plugins()[0]?.capabilities).toEqual({
      declared: ["fs.read"],
      used: ["fs.read"],
    });
  });
});

describe("setup failure rollback", () => {
  it("unregisters everything a failed setup registered", async () => {
    const kernel = createKernel();
    const failing: Plugin = {
      manifest: manifest({ name: "failing" }),
      setup: (k) => {
        const { def, handler } = helloTool();
        k.tools.register(def, handler);
        k.services.set("plugin:failing:cache", { v: 1 });
        throw new Error("setup blew up");
      },
    };
    await expect(kernel.use(failing)).rejects.toThrow("setup blew up");
    expect(kernel.tools.get("plugin-tool")).toBeNull();
    expect(kernel.services.has("plugin:failing:cache")).toBe(false);
    expect(kernel.list_plugins()).toEqual([]);
  });
});
