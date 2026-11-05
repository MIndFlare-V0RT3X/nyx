// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import type { Engagement } from "@nyx/protocol";
import { canonicalJson } from "@nyx/protocol";
import {
  registerSecurityToolMeta,
  clearSecurityToolMeta,
  securityToolMeta,
  isSecurityTool,
  engagementToolAllowlist,
  EngagementToolRegistry,
  buildEngagementTooling,
} from "./tool_filter.js";
import { createScopeEngine, actionDigest } from "./engine.js";
import type { SessionEvent, ToolDefinition, ToolHandler, ToolRegistry } from "@nyx/protocol";
import { ToolRegistryImpl } from "@nyx/tools";
import type { ToolRuntime } from "@nyx/tools";
import type {
  ApprovalEngine,
  Kernel,
  Logger,
  PolicyEngine,
  Sandbox,
  ServiceRegistry,
  ToolOutput,
} from "@nyx/protocol";

const NOW = 1_700_000_000_000;

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "ENG-2026-042",
    operator_id: "owner",
    authorized_at: NOW - 60_000,
    expires_at: NOW + 3_600_000,
    targets: { cidrs: ["203.0.113.0/24"], domains: ["example.com"] },
    techniques: ["reconnaissance", "web_enumeration"],
    ...overrides,
  };
}

// Fixture security-tool meta (unique names; cleared after the file).
registerSecurityToolMeta("security.probe-ports", {
  technique: "port_scanning",
  rate_class: "nmap",
  unit: "packets",
});
registerSecurityToolMeta("security.probe-web", {
  technique: "web_enumeration",
  rate_class: "httpx",
  unit: "requests",
});
afterAll(() => clearSecurityToolMeta());

describe("security tool meta registry", () => {
  it("registers and looks up by tool name", () => {
    expect(securityToolMeta("security.probe-ports")).toEqual({
      technique: "port_scanning",
      rate_class: "nmap",
      unit: "packets",
    });
    expect(isSecurityTool("security.probe-web")).toBe(true);
    expect(isSecurityTool("fs.read")).toBe(false);
    expect(securityToolMeta("fs.read")).toBeUndefined();
  });
});

describe("engagementToolAllowlist — the technique predicate (§1.3 layer 1)", () => {
  it("a security tool is visible only when its technique is authorized", () => {
    const allowed = engagementToolAllowlist(engagement());
    expect(allowed("security.probe-web")).toBe(true); // web_enumeration ✓
    expect(allowed("security.probe-ports")).toBe(false); // port_scanning ✗
  });

  it("non-security tools always pass — they are not technique-gated", () => {
    expect(engagementToolAllowlist(engagement())("fs.read")).toBe(true);
    expect(engagementToolAllowlist(null)("fs.read")).toBe(true);
  });

  it("an engagement with no techniques authorizes NO security tool", () => {
    const allowed = engagementToolAllowlist(engagement({ techniques: [] }));
    expect(allowed("security.probe-web")).toBe(false);
    expect(allowed("security.probe-ports")).toBe(false);
  });

  it("no engagement at all → no offensive tools, structurally (§1.6)", () => {
    const allowed = engagementToolAllowlist(null);
    expect(allowed("security.probe-web")).toBe(false);
    expect(allowed("security.probe-ports")).toBe(false);
  });
});

describe("EngagementToolRegistry — the read-through view", () => {
  function fixtureRegistry(): ToolRegistry {
    const reg = new ToolRegistryImpl();
    const def = (name: string): ToolDefinition => ({
      name,
      description: `fixture ${name}`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "R0",
      capabilities: [],
      handler: `builtin:${name}`,
    });
    const handler: ToolHandler = {
      async execute(): Promise<ToolOutput> {
        return { kind: "text", text: "ok" };
      },
    };
    reg.register(def("fs.probe"), handler);
    reg.register(def("security.probe-web"), handler);
    reg.register(def("security.probe-ports"), handler);
    return reg;
  }

  it("list() and get() hide unauthorized security tools; others pass through", () => {
    const view = new EngagementToolRegistry(
      fixtureRegistry(),
      engagementToolAllowlist(engagement()),
    );
    expect(
      view
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["fs.probe", "security.probe-web"]);
    expect(view.get("security.probe-ports")).toBeNull();
    expect(view.get("security.probe-web")?.def.name).toBe("security.probe-web");
    expect(view.get("fs.probe")?.def.name).toBe("fs.probe");
  });

  it("with no engagement, every security tool is absent", () => {
    const view = new EngagementToolRegistry(fixtureRegistry(), engagementToolAllowlist(null));
    expect(view.list().map((d) => d.name)).toEqual(["fs.probe"]);
  });
});

describe("the two-layer proof (§1.7) — layer 1: registry absence", () => {
  const eng = engagement(); // web_enumeration only

  function rig() {
    const reg = new ToolRegistryImpl();
    const def = (name: string, caps: ToolDefinition["capabilities"]): ToolDefinition => ({
      name,
      description: `fixture ${name}`,
      input_schema: { type: "object", properties: {}, additionalProperties: false },
      risk: "R0",
      capabilities: caps,
      handler: `builtin:${name}`,
    });
    const handler: ToolHandler = {
      async execute(): Promise<ToolOutput> {
        return { kind: "text", text: "ok" };
      },
    };
    reg.register(def("fs.probe", []), handler);
    reg.register(def("security.probe-web", []), handler);
    reg.register(def("security.probe-ports", []), handler);
    return reg;
  }

  const noopLogger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  };
  const fakeSandbox: Sandbox = {
    id: "sbx-fixture",
    workdir: "/tmp/fixture",
    exec: async () => {
      throw new Error("fixture sandbox never execs");
    },
    readFile: async () => {
      throw new Error("fixture sandbox never reads");
    },
    writeFile: async () => {
      throw new Error("fixture sandbox never writes");
    },
    list: async () => [],
    destroy: async () => {},
  };

  it("a technique-filtered tool returns tool_unknown from the runtime", async () => {
    const { tools, kernel } = buildEngagementTooling(
      {
        tools: rig(),
        kernel: fakeKernel(),
        policy: allowAllPolicy(),
        approvals: autoApprove(),
      },
      eng,
    );
    expect(tools.get("security.probe-ports")).toBeNull(); // absent from the registry

    const runtime = kernel.services.get<ToolRuntime>("tools.runtime")!;
    const events: SessionEvent[] = [];
    const out = await runtime.execute(
      { call_id: "c1", name: "security.probe-ports", input: {} },
      {
        session_id: "s1",
        turn_id: "t1",
        engagement: eng,
        sandbox: fakeSandbox,
        signal: new AbortController().signal,
        logger: noopLogger,
        emit: (e) => events.push(e),
      },
    );
    // The model-facing surface: unknown tool text.
    expect(out).toEqual({ kind: "text", text: 'error: unknown tool "security.probe-ports"' });
    // The event surface: tool.error with error.code tool_unknown — the
    // acceptance's exact token.
    const err = events.find((e) => e.type === "tool.error");
    expect(err).toBeDefined();
    expect((err as { error: { code?: string } }).error.code).toBe("tool_unknown");
    expect((err as { error: { message?: string } }).error.message).toContain(
      'unknown tool "security.probe-ports"',
    );
  });

  it("an authorized security tool and non-security tools still execute", async () => {
    const { kernel } = buildEngagementTooling(
      {
        tools: rig(),
        kernel: fakeKernel(),
        policy: allowAllPolicy(),
        approvals: autoApprove(),
      },
      eng,
    );
    const runtime = kernel.services.get<ToolRuntime>("tools.runtime")!;
    for (const name of ["fs.probe", "security.probe-web"]) {
      const out = await runtime.execute(
        { call_id: "c1", name, input: {} },
        {
          session_id: "s1",
          turn_id: "t1",
          engagement: eng,
          sandbox: fakeSandbox,
          signal: new AbortController().signal,
          logger: noopLogger,
          emit: () => {},
        },
      );
      expect(out).toEqual({ kind: "text", text: "ok" });
    }
  });

  it("layer 2 proof: the engine denies an out-of-scope target even with NO registry in play", () => {
    // Bypassing layer 1 entirely — construct the engine directly (a unit
    // path a mis-registered tool would take) and ask about an out-of-scope
    // host. The egress-path check still denies.
    const engine = createScopeEngine(engagement(), { now: () => NOW });
    const out = engine.check({
      tool: "security.probe-web",
      targets: [{ host: "evilcorp.example.net" }],
    });
    expect(out.decision).toBe("deny");
    expect(out.reason).toContain("not in engagement scope");
  });
});

describe("actionDigest", () => {
  it("binds the exact action: same action → same digest; different → different", () => {
    const a = { tool: "security.probe-web", targets: [{ host: "example.com" }] };
    const b = { tool: "security.probe-web", targets: [{ host: "example.com" }] };
    const c = { tool: "security.probe-web", targets: [{ host: "api.example.com" }] };
    expect(actionDigest(a)).toBe(actionDigest(b));
    expect(actionDigest(a)).not.toBe(actionDigest(c));
    expect(actionDigest(a)).toMatch(/^[0-9a-f]{64}$/);
    // Canonical: key order does not matter.
    expect(actionDigest({ tool: "t", targets: [{ host: "h", port: 443 }] })).toBe(
      actionDigest({ tool: "t", targets: [{ port: 443, host: "h" }] }),
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

// ── fixtures ────────────────────────────────────────────────────────────────

function allowAllPolicy(): PolicyEngine {
  return {
    async evaluate(req) {
      return {
        decision: "allow",
        rule_id: "test:allow-all",
        action_digest: "0".repeat(64),
        summary: `${req.tool} (test allow-all)`,
      };
    },
  };
}

function autoApprove(): ApprovalEngine {
  const never = async (): Promise<never> => {
    throw new Error("approvals should not be reached in these fixtures");
  };
  return {
    request: async () => "allow",
    resolve: never,
    get: async () => null,
    pending: async () => [],
    consume: never,
  };
}

function fakeKernel(): Kernel {
  const services = new Map<string, unknown>();
  const registry: ServiceRegistry = {
    get: <T>(name: string): T | undefined => services.get(name) as T | undefined,
    set: (name: string, s: unknown): void => {
      services.set(name, s);
    },
    has: (name: string): boolean => services.has(name),
    delete: (name: string): void => {
      services.delete(name);
    },
  };
  return {
    version: "0-test",
    hooks: { on: () => () => {}, emit: async () => [] },
    tools: new ToolRegistryImpl(),
    services: registry,
    use: async () => {},
    unuse: async () => {},
  } as unknown as Kernel;
}
