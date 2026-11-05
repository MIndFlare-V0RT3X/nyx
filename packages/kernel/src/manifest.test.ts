// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { CapabilitySchema } from "@nyx/protocol";
import { HOOK_NAMES, manifestIssues, pluginManifestSchema, v1MigrationHints } from "./manifest.js";

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

const SHA = "a".repeat(64);
const SIG = {
  public_key: "b".repeat(64),
  signature: "c".repeat(128),
};

const valid = {
  manifest_version: 2,
  name: "my-plugin",
  version: "1.0.0",
  nyx: "^0.1.0",
  capabilities: ["fs.read"],
  integrity: SHA,
};

describe("pluginManifestSchema (v2)", () => {
  it("accepts a minimal manifest", () => {
    const parsed = pluginManifestSchema.safeParse(valid);
    expect(parsed.success).toBe(true);
  });

  it("accepts a full manifest with every optional field", () => {
    const parsed = pluginManifestSchema.safeParse({
      ...valid,
      dependencies: [{ name: "other-plugin", version_range: ">=1.0.0" }],
      signature: SIG,
      hooks: ["context.initialize", "action.before", "action.after", "feedback.recover"],
      tools: ["fs.read_file"],
      permissions: { fs: ["/home/**"], net: ["https://example.com"] },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a v1 manifest (no manifest_version / string dependencies / no integrity)", () => {
    const v1 = {
      name: "legacy",
      version: "1.0.0",
      nyx: "^0.1.0",
      capabilities: ["fs.read"],
      dependencies: ["other-plugin"],
    };
    const parsed = pluginManifestSchema.safeParse(v1);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const text = manifestIssues(parsed.error).join(" ").toLowerCase();
      expect(text).toContain("manifest_version");
    }
    // And the migration hints say exactly what to change.
    const hints = v1MigrationHints(v1);
    expect(hints.join(" ")).toContain("manifest_version");
    expect(hints.join(" ")).toContain("version_range");
    expect(hints.join(" ")).toContain("integrity");
  });

  it("gives no v1 hints for a merely-invalid v2 manifest", () => {
    expect(v1MigrationHints({ ...valid, name: 42 })).toEqual([]);
    // A v2 manifest with a bad integrity is a v2 problem, not a migration.
    expect(v1MigrationHints({ ...valid, integrity: "not-hex" })).toEqual([]);
  });

  it("accepts all 13 protocol capabilities and rejects anything else", () => {
    expect(
      pluginManifestSchema.safeParse({ ...valid, capabilities: [...ALL_CAPABILITIES] }).success,
    ).toBe(true);
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: ["fs.exec"] }).success).toBe(
      false,
    );
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: ["FS.READ"] }).success).toBe(
      false,
    );
    expect(pluginManifestSchema.safeParse({ ...valid, capabilities: "fs.read" }).success).toBe(
      false,
    );
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

  it("rejects malformed dependencies, integrity, and signature blocks", () => {
    // v1-style string dependencies are a hard type error now.
    expect(pluginManifestSchema.safeParse({ ...valid, dependencies: ["other"] }).success).toBe(
      false,
    );
    expect(
      pluginManifestSchema.safeParse({ ...valid, dependencies: [{ name: "x" }] }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({
        ...valid,
        dependencies: [{ name: "x", version_range: 7 }],
      }).success,
    ).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, dependencies: "other" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, tools: [""] }).success).toBe(false);
    // integrity: 64 lowercase hex, nothing else.
    expect(pluginManifestSchema.safeParse({ ...valid, integrity: "XYZ" }).success).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...valid, integrity: SHA.toUpperCase() }).success).toBe(
      false,
    );
    expect(pluginManifestSchema.safeParse({ ...valid, integrity: SHA.slice(1) }).success).toBe(
      false,
    );
    // signature: both fields, exact hex lengths.
    expect(
      pluginManifestSchema.safeParse({ ...valid, signature: { public_key: "zz" } }).success,
    ).toBe(false);
    expect(
      pluginManifestSchema.safeParse({ ...valid, signature: { ...SIG, extra: 1 } }).success,
    ).toBe(false);
  });

  it("rejects hook names outside the four-hook surface", () => {
    expect(pluginManifestSchema.safeParse({ ...valid, hooks: ["action.before"] }).success).toBe(
      true,
    );
    expect(pluginManifestSchema.safeParse({ ...valid, hooks: ["action.during"] }).success).toBe(
      false,
    );
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
