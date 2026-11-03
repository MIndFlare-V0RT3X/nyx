// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CapabilitySchema } from "@nyx/protocol";
import { HOOK_NAMES, manifestIssues, pluginManifestSchema } from "./manifest.js";

const ALL_CAPABILITIES = [
  "fs.read",
  "fs.write",
  "fs.delete",
  "proc.spawn",
  "proc.kill",
  "net.egress",
  "net.listen",
  "browser.control",
  "desktop.control",
  "credential.use",
  "host.access",
  "git.push",
  "deploy",
] as const;

const valid = {
  name: "my-plugin",
  version: "1.0.0",
  nyx: "^0.1.0",
  capabilities: ["fs.read"],
};

describe("pluginManifestSchema", () => {
  it("accepts a minimal manifest", () => {
    const parsed = pluginManifestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("accepts a full manifest with every optional field", () => {
    const parsed = pluginManifestSchema.safeParse({
      ...valid,
      dependencies: ["other-plugin"],
      hooks: ["context.initialize", "action.before", "action.after", "feedback.recover"],
      tools: ["fs.read_file"],
      permissions: { fs: ["/home/**"], net: ["https://example.com"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts all 13 protocol capabilities and rejects anything else", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: [...ALL_CAPABILITIES] }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: ["fs.exec"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: ["FS.READ"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: "fs.read" }).success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const parsed = pluginManifestSchema.safeParse({ ...valid, surprise: true });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(manifestIssues(parsed.error).join(" ").toLowerCase()).toContain("unrecognized");
    }
  });

  it("rejects unknown permission keys", () => {
    const parsed = pluginManifestSchema.safeParse({ ...valid, permissions: { exec: ["*"] } });
    expect(parsed.success).toBe(false);
  });

  it("rejects bad names", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, name: 42 }).success).toBe(false);
    // ':' would let one plugin's service namespace prefix another's.
    expect(pluginManifestSchema.safeParse({ ...valid, name: "evil:name" }).success).toBe(false);
  });

  it("rejects empty version and nyx", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, version: "" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, nyx: "" }).success).toBe(false);
  });

  it("rejects non-string-array dependencies and tools", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, dependencies: [7] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, dependencies: "other" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, tools: [""] }).success).toBe(false);
  });

  it("rejects hook names outside the four-hook surface", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, hooks: ["action.before"] }).success).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...valid, hooks: ["action.during"] }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, hooks: ["tool.call"] }).success).toBe(false);
  });

  it("issues name the offending path", () => {
    const parsed = pluginManifestSchema.safeParse({ ...valid, nyx: 123 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(manifestIssues(parsed.error).some((issue) => issue.startsWith("nyx:"))).toBe(true);
    }
  });
});

describe("hook name set", () => {
  it("is exactly the four-hook surface", () => {
    expect([...HOOK_NAMES]).toEqual([
      "context.initialize",
      "action.before",
      "action.after",
      "feedback.recover",
    ]);
  });
});

describe("CapabilitySchema re-export check", () => {
  it("parses a capability", () => {
    expect(CapabilitySchema.safeParse("net.egress").success).toBe(true);
    expect(CapabilitySchema.safeParse("net.escape").success).toBe(false);
  });
});
