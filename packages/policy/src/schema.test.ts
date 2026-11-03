// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { policyRuleSchema } from "./schema.js";

describe("policyRuleSchema.parse", () => {
  it("parses a fully-specified rule", () => {
    const rule = {
      id: "allow-reads",
      match: {
        tool: ["fs.read", "fs.stat"],
        capability: "fs.read",
        risk: ["R0", "R1"],
        path_prefix: "/tmp",
        host: "example.com",
        owner_only: true,
      },
      decision: "allow",
      reason: "scratch reads are fine",
      immutable: false,
    };
    expect(policyRuleSchema.parse(rule)).toEqual(rule);
  });

  it("parses a minimal rule", () => {
    expect(policyRuleSchema.parse({ id: "x", match: { tool: "fs.read" }, decision: "ask" })).toEqual({
      id: "x",
      match: { tool: "fs.read" },
      decision: "ask",
    });
  });

  it("omits optional fields rather than materializing them", () => {
    const parsed = policyRuleSchema.parse({ id: "x", match: { risk: "R2" }, decision: "deny" });
    expect(parsed).not.toHaveProperty("reason");
    expect(parsed).not.toHaveProperty("immutable");
  });
});

describe("policyRuleSchema.safeParse", () => {
  it("returns success:false with a message instead of throwing", () => {
    const result = policyRuleSchema.safeParse({ id: "", match: { tool: "fs.read" }, decision: "allow" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("id");
  });

  it.each([
    ["not an object", "banana"],
    ["missing id", { match: { tool: "fs.read" }, decision: "allow" }],
    ["empty id", { id: "", match: { tool: "fs.read" }, decision: "allow" }],
    ["missing match", { id: "x", decision: "allow" }],
    ["empty match", { id: "x", match: {}, decision: "allow" }],
    ["unknown match field", { id: "x", match: { tool: "fs.read", toolz: "fs.write" }, decision: "allow" }],
    ["unknown top-level field", { id: "x", match: { tool: "fs.read" }, decision: "allow", decizion: "deny" }],
    ["bad decision", { id: "x", match: { tool: "fs.read" }, decision: "maybe" }],
    ["bad capability", { id: "x", match: { capability: "fs.fly" }, decision: "allow" }],
    ["bad risk", { id: "x", match: { risk: "R9" }, decision: "allow" }],
    ["bad risk in list", { id: "x", match: { risk: ["R1", "R9"] }, decision: "allow" }],
    ["non-string tool", { id: "x", match: { tool: 42 }, decision: "allow" }],
    ["empty tool list", { id: "x", match: { tool: [] }, decision: "allow" }],
    ["non-boolean owner_only", { id: "x", match: { owner_only: "yes" }, decision: "allow" }],
    ["non-string path_prefix", { id: "x", match: { path_prefix: 1 }, decision: "allow" }],
    ["non-string reason", { id: "x", match: { tool: "fs.read" }, decision: "allow", reason: 3 }],
    ["non-boolean immutable", { id: "x", match: { tool: "fs.read" }, decision: "allow", immutable: 1 }],
  ])("rejects %s", (_label, value) => {
    const result = policyRuleSchema.safeParse(value);
    expect(result.success).toBe(false);
    if (!result.success) expect(typeof result.error).toBe("string");
  });

  it("accepts every valid capability and risk tier", () => {
    for (const cap of ["fs.read", "fs.write", "fs.delete", "proc.spawn", "proc.kill", "net.egress", "net.listen", "browser.control", "desktop.control", "credential.use", "host.access", "git.push", "deploy"]) {
      expect(policyRuleSchema.safeParse({ id: "x", match: { capability: cap }, decision: "ask" }).success).toBe(true);
    }
    for (const risk of ["R0", "R1", "R2", "R3", "R4"]) {
      expect(policyRuleSchema.safeParse({ id: "x", match: { risk }, decision: "ask" }).success).toBe(true);
    }
    for (const decision of ["allow", "ask", "deny"]) {
      expect(policyRuleSchema.safeParse({ id: "x", match: { tool: "fs.read" }, decision }).success).toBe(true);
    }
  });

  it("parse throws a typed error with code validation_failed", () => {
    try {
      policyRuleSchema.parse({ id: "x", match: { risk: "R9" }, decision: "allow" });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("validation_failed");
    }
  });
});
