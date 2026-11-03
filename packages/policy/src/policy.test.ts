// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { ActionRequest, PolicyRule } from "@nyx/protocol";
import { computeActionDigest, summarizeAction } from "./policy.js";
import { PolicyEngineImpl } from "./policy.js";

function action(overrides: Partial<ActionRequest> = {}): ActionRequest {
  return {
    session_id: "s1",
    turn_id: "t1",
    tool: "fs.read",
    input: { path: "/tmp/notes.txt" },
    risk: "R2",
    capabilities: ["fs.read"],
    actor_id: "agent",
    ...overrides,
  };
}

describe("decision resolution", () => {
  it("deny overrides allow regardless of rule order (allow first)", async () => {
    const engine = new PolicyEngineImpl([
      { id: "allow-reads", match: { tool: ["fs.read"] }, decision: "allow" },
      { id: "deny-tmp", match: { path_prefix: "/tmp" }, decision: "deny" },
    ]);
    const v = await engine.evaluate(action({ input: { path: "/tmp/notes.txt" } }));
    expect(v.decision).toBe("deny");
    expect(v.rule_id).toBe("deny-tmp");
  });

  it("deny overrides allow regardless of rule order (deny first)", async () => {
    const engine = new PolicyEngineImpl([
      { id: "deny-tmp", match: { path_prefix: "/tmp" }, decision: "deny" },
      { id: "allow-reads", match: { tool: ["fs.read"] }, decision: "allow" },
    ]);
    const v = await engine.evaluate(action({ input: { path: "/tmp/notes.txt" } }));
    expect(v.decision).toBe("deny");
    expect(v.rule_id).toBe("deny-tmp");
  });

  it("prefers the FIRST deny when several match", async () => {
    const engine = new PolicyEngineImpl([
      { id: "deny-a", match: { tool: "fs.read" }, decision: "deny" },
      { id: "deny-b", match: { risk: ["R2"] }, decision: "deny" },
    ]);
    const v = await engine.evaluate(action());
    expect(v.rule_id).toBe("deny-a");
  });

  it("allows with the LAST matching allow rule's id", async () => {
    const engine = new PolicyEngineImpl([
      { id: "allow-1", match: { tool: ["fs.read"] }, decision: "allow" },
      { id: "allow-2", match: { risk: ["R2"] }, decision: "allow" },
    ]);
    const v = await engine.evaluate(action());
    expect(v.decision).toBe("allow");
    expect(v.rule_id).toBe("allow-2");
  });

  it("ask beats allow", async () => {
    const engine = new PolicyEngineImpl([
      { id: "allow-1", match: { tool: ["fs.read"] }, decision: "allow" },
      { id: "ask-1", match: { risk: ["R2"] }, decision: "ask" },
    ]);
    const v = await engine.evaluate(action());
    expect(v.decision).toBe("ask");
    expect(v.rule_id).toBe("ask-1");
  });

  it("unknown actions escalate to ask with the default rule id", async () => {
    const engine = new PolicyEngineImpl([{ id: "allow-reads", match: { tool: "fs.read" }, decision: "allow" }]);
    const v = await engine.evaluate(action({ tool: "net.egress", capabilities: ["net.egress"] }));
    expect(v).toMatchObject({ decision: "ask", rule_id: "default:unknown-action" });
  });

  it("an empty ruleset asks on everything", async () => {
    const engine = new PolicyEngineImpl([]);
    const v = await engine.evaluate(action());
    expect(v).toMatchObject({ decision: "ask", rule_id: "default:unknown-action" });
  });
});

describe("immutable invariants", () => {
  it("a config allow on risk R4 still yields ask", async () => {
    const engine = new PolicyEngineImpl([{ id: "allow-r4", match: { risk: ["R4"] }, decision: "allow" }]);
    const v = await engine.evaluate(action({ risk: "R4", input: { path: "/home/me/secret" } }));
    expect(v.decision).toBe("ask");
    expect(v.rule_id).toBe("invariant:r4-owner-approval");
    expect(v.summary).toContain("owner approval required");
  });

  it("R4 asks even with zero config rules", async () => {
    const engine = new PolicyEngineImpl([]);
    const v = await engine.evaluate(action({ risk: "R4" }));
    expect(v).toMatchObject({ decision: "ask", rule_id: "invariant:r4-owner-approval" });
  });

  it("a config allow on a dangerous capability still yields ask", async () => {
    const engine = new PolicyEngineImpl([
      { id: "push-ok", match: { capability: "git.push" }, decision: "allow" },
    ]);
    const v = await engine.evaluate(action({ tool: "git.push", capabilities: ["fs.write", "git.push"] }));
    expect(v.decision).toBe("ask");
    expect(v.rule_id).toBe("invariant:dangerous-capability");
  });

  it.each(["host.access", "credential.use", "git.push", "deploy"] as const)(
    "capability %s forces at least ask",
    async (cap) => {
      const engine = new PolicyEngineImpl([{ id: "allow-all", match: { risk: ["R1"] }, decision: "allow" }]);
      const v = await engine.evaluate(action({ risk: "R1", capabilities: [cap] }));
      expect(v.decision).toBe("ask");
      expect(v.rule_id).toBe("invariant:dangerous-capability");
    },
  );

  it("invariants only raise: a config deny still denies R4", async () => {
    const engine = new PolicyEngineImpl([{ id: "deny-r4", match: { risk: ["R4"] }, decision: "deny" }]);
    const v = await engine.evaluate(action({ risk: "R4" }));
    expect(v).toMatchObject({ decision: "deny", rule_id: "deny-r4" });
  });

  it("R4 wins over the dangerous-capability invariant id", async () => {
    const engine = new PolicyEngineImpl([]);
    const v = await engine.evaluate(action({ risk: "R4", capabilities: ["git.push"] }));
    expect(v.rule_id).toBe("invariant:r4-owner-approval");
  });
});

describe("rule matching", () => {
  it("matches on capability intersection", async () => {
    const engine = new PolicyEngineImpl([
      { id: "writes-ask", match: { capability: ["fs.write", "fs.delete"] }, decision: "ask" },
    ]);
    expect((await engine.evaluate(action({ capabilities: ["fs.read"] }))).rule_id).toBe(
      "default:unknown-action",
    );
    expect((await engine.evaluate(action({ capabilities: ["fs.read", "fs.write"] }))).rule_id).toBe(
      "writes-ask",
    );
  });

  it("owner_only rules only apply when the actor is the owner", async () => {
    const rule: PolicyRule = { id: "owner-allow", match: { owner_only: true }, decision: "allow" };
    const engine = new PolicyEngineImpl([rule]);
    expect((await engine.evaluate(action({ actor_id: "owner" }))).decision).toBe("allow");
    expect((await engine.evaluate(action({ actor_id: "agent" }))).decision).toBe("ask");
  });

  it("every present match field must match", async () => {
    const engine = new PolicyEngineImpl([
      { id: "narrow", match: { tool: "fs.read", risk: ["R1"] }, decision: "allow" },
    ]);
    expect((await engine.evaluate(action({ risk: "R1" }))).rule_id).toBe("narrow");
    expect((await engine.evaluate(action({ risk: "R2" }))).rule_id).toBe("default:unknown-action");
  });

  it("host rules prefix-match the input's host field", async () => {
    const engine = new PolicyEngineImpl([
      { id: "lan-allow", match: { host: "192.168." }, decision: "allow" },
    ]);
    expect((await engine.evaluate(action({ input: { host: "192.168.1.10" } }))).decision).toBe("allow");
    expect((await engine.evaluate(action({ input: { host: "example.com" } }))).decision).toBe("ask");
  });
});

describe("computeActionDigest", () => {
  it("is stable under input key reordering", () => {
    const a = computeActionDigest(action({ input: { path: "/a", url: "https://b" } }));
    const b = computeActionDigest(action({ input: { url: "https://b", path: "/a" } }));
    expect(a).toBe(b);
  });

  it("changes when the input changes", () => {
    const a = computeActionDigest(action({ input: { path: "/a" } }));
    const b = computeActionDigest(action({ input: { path: "/b" } }));
    expect(a).not.toBe(b);
  });

  it("changes when the risk changes", () => {
    const a = computeActionDigest(action({ risk: "R1" }));
    const b = computeActionDigest(action({ risk: "R2" }));
    expect(a).not.toBe(b);
  });

  it("changes when the tool changes", () => {
    const a = computeActionDigest(action({ tool: "fs.read" }));
    const b = computeActionDigest(action({ tool: "fs.write" }));
    expect(a).not.toBe(b);
  });

  it("is a 64-char lowercase hex sha256", () => {
    expect(computeActionDigest(action())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("summary", () => {
  it("contains the tool name, key params, and the risk tier", async () => {
    const engine = new PolicyEngineImpl([]);
    const v = await engine.evaluate(action({ input: { path: "/tmp/notes.txt", host: "example.com" } }));
    expect(v.summary).toContain('"fs.read"');
    expect(v.summary).toContain("/tmp/notes.txt");
    expect(v.summary).toContain("example.com");
    expect(v.summary).toContain("[risk R2]");
  });

  it("falls back to a canonical JSON sketch capped at 120 chars", () => {
    const long = { blob: "x".repeat(400) };
    const summary = summarizeAction(action({ tool: "fs.write", input: long, risk: "R3" }));
    expect(summary).toContain('"fs.write"');
    expect(summary).toContain("[risk R3]");
    const sketch = summary.slice(summary.indexOf(" on ") + 4, summary.indexOf(" [risk"));
    expect(sketch.length).toBeLessThanOrEqual(120);
    expect(sketch.endsWith("...")).toBe(true);
  });

  it("handles non-object inputs", () => {
    const summary = summarizeAction(action({ input: ["a", "b"], risk: "R1" }));
    expect(summary).toContain('"fs.read"');
    expect(summary).toContain('["a","b"]');
    expect(summary).toContain("[risk R1]");
  });
});
