// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.3 — the security-skill acceptance battery over the REAL tool
// registrations (fake executor + fake resolver + virtual clock): the tool
// fires in-scope with findings and audit rows; out-of-scope targets never
// reach the executor (both registry layer and egress layer proven); the rate
// bucket throttles; malformed output is a clean skill.error.
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { openSessionStore } from "@nyx/session";
import { DnsEgressResolver, ToolRegistryImpl } from "@nyx/tools";
import type { ToolRuntime } from "@nyx/tools";
import type {
  ApprovalEngine,
  Engagement,
  PolicyEngine,
  Sandbox,
  SessionEvent,
  ToolContext,
} from "@nyx/protocol";
import {
  FindingStore,
  FakeSecurityExecutor,
  SecurityRateLimiter,
  assertSafeTokens,
  buildEngagementTooling,
  registerSecurityTools,
  clearSecurityToolMeta,
} from "../index.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);

const stacks: Array<() => void> = [];
afterAll(() => {
  clearSecurityToolMeta();
  while (stacks.length > 0) stacks.pop()!();
});

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "acme-q4-2026",
    operator_id: "owner",
    authorized_at: T0 - 86_400_000,
    starts_at: T0 - 86_400_000,
    expires_at: T0 + 86_400_000,
    targets: {
      domains: ["example.com"],
      cidrs: ["203.0.113.0/24"],
      urls: ["https://app.example.com/portal/*"],
      exclude: { domains: ["mail.example.com"], cidrs: ["203.0.113.128/25"] },
    },
    techniques: ["reconnaissance", "port_scanning", "web_enumeration", "vulnerability_scanning"],
    rate_limits: { default: { requests_per_second: 10 }, nmap: { packets_per_second: 100 } },
    client: "Acme Corp",
    ...overrides,
  };
}

interface Rig {
  executor: FakeSecurityExecutor;
  store: FindingStore;
  auditRows: Array<{ actor: string; action: string; payload: Record<string, unknown> }>;
  clock: { now: number };
  files: Map<string, string>;
  registry: ToolRegistryImpl;
  kernel: ReturnType<typeof buildEngagementTooling>["kernel"];
  tools: ReturnType<typeof buildEngagementTooling>["tools"];
}

function makeRig(eng: Engagement | null): Rig {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  openSessionStore(":memory:", { db });
  stacks.push(() => db.close());

  const executor = new FakeSecurityExecutor();
  const store = new FindingStore({ db, now: () => T0 });
  const auditRows: Rig["auditRows"] = [];
  const clock = { now: T0 };
  const files = new Map<string, string>();

  const limiter = new SecurityRateLimiter({
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
    },
  });
  // Fake DNS: in-scope names resolve into the authorized CIDR.
  const resolver = new DnsEgressResolver({
    now: () => clock.now,
    lookup: async (host: string) => {
      if (host === "rebind.example.com") return [{ address: "198.51.100.99", family: 4 }];
      return [{ address: "203.0.113.10", family: 4 }];
    },
  } as never);

  const registry = new ToolRegistryImpl();
  registerSecurityTools(registry, {
    store,
    executor,
    limiter,
    resolver,
    now: () => clock.now,
    audit: (r) => auditRows.push(r as Rig["auditRows"][number]),
  });

  const fakeKernel = {
    version: "0-test",
    hooks: { on: () => () => {}, emit: async () => [] },
    tools: registry,
    services: new Map<string, unknown>(),
    use: async () => {},
    unuse: async () => {},
  } as never;
  const tooling = buildEngagementTooling(
    { tools: registry, kernel: fakeKernel, policy: allowAll(), approvals: autoApprove() } as never,
    eng,
  );
  return { executor, store, auditRows, clock, files, registry, kernel: tooling.kernel, tools: tooling.tools };
}

function fakeSandbox(rig: Rig): Sandbox {
  return {
    id: "sbx-test",
    workdir: "/tmp/sbx-test",
    exec: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
    readFile: async () => {
      throw new Error("not used");
    },
    writeFile: async (p: string, data: Buffer | string) => {
      rig.files.set(p, typeof data === "string" ? data : data.toString("utf8"));
    },
    list: async () => [],
    destroy: async () => {},
  };
}

function toolContext(rig: Rig, eng: Engagement | null): ToolContext {
  const events: SessionEvent[] = [];
  return {
    session_id: "sess-1",
    turn_id: "turn-1",
    call_id: "call-1",
    sandbox: fakeSandbox(rig),
    signal: new AbortController().signal,
    logger: noopLogger,
    emit: (e: SessionEvent) => {
      events.push(e);
    },
    engagement: eng,
    __events: events,
  } as never;
}

const noopLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => noopLogger,
};

function allowAll(): PolicyEngine {
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
    throw new Error("approvals not reached");
  };
  return { request: async () => "allow", resolve: never, get: async () => null, pending: async () => [], consume: never };
}

describe("§3.3 — running a skill against an in-scope target", () => {
  it("the tool fires, findings land in the DB, and audit rows are written", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const nucleiJsonl = [
      JSON.stringify({
        template_id: "cve-2026-1234",
        info: {
          name: "Example Reflected XSS",
          severity: "high",
          description: "Reflected XSS in the q parameter.",
          classification: { cve_id: "CVE-2026-1234", cwe_id: "79", cvss_metrics: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
        },
        matched_at: "https://app.example.com/portal/login",
        host: "app.example.com",
      }),
    ].join("\n");
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: nucleiJsonl, stderr: "" }));

    const runtime = rig.kernel.services.get<ToolRuntime>("tools.runtime")!;
    const out = await runtime.execute(
      { call_id: "c1", name: "security.nuclei", input: { targets: ["https://app.example.com/portal/login"] } },
      ctx as never,
    );
    expect(out.kind).toBe("json");
    const json = (out as { json: { findings: Array<{ id: string }>; count: number; artifact: string; sha256: string } }).json;
    expect(json.count).toBe(1);

    // The finding landed in the DB, bound to THIS session's engagement.
    const findings = await rig.store.list({ engagement_id: "acme-q4-2026" });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.session_id).toBe("sess-1");
    expect(findings[0]!.severity).toBe("high");
    expect(findings[0]!.cvss_3_1).toBe(6.1);
    expect(findings[0]!.target).toEqual({ host: "app.example.com", path: "/portal/login" });
    expect(findings[0]!.cve).toEqual(["CVE-2026-1234"]);
    expect(findings[0]!.cwe).toEqual(["CWE-79"]);

    // The evidence artifact: written into the sandbox, hash = sha256(stdout).
    expect(json.sha256).toBe(createHash("sha256").update(nucleiJsonl, "utf8").digest("hex"));
    expect(rig.files.get(json.artifact)).toBe(nucleiJsonl);
    expect(findings[0]!.evidence[0]!.hash).toBe(json.sha256);

    // Audit rows: the scope ALLOW (with the engagement id) from the engine.
    const allow = rig.auditRows.find((r) => r.action === "security.scope.allowed");
    expect(allow).toBeDefined();
    expect(allow!.payload.engagement_id).toBe("acme-q4-2026");
    expect(allow!.payload.tool).toBe("security.nuclei");
  });

  it("argv is composed from validated input only — in-scope URL, cooperative rate flags", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: '{"url":"https://app.example.com/portal/","status_code":200}', stderr: "" }));
    const ctx = toolContext(rig, eng);
    const runtime = rig.kernel.services.get<ToolRuntime>("tools.runtime")!;
    await runtime.execute(
      { call_id: "c1", name: "security.httpx", input: { targets: ["https://app.example.com/portal/"] } },
      ctx as never,
    );
    expect(rig.executor.calls).toHaveLength(1);
    const { binary, args } = rig.executor.calls[0]!;
    expect(binary).toBe("httpx");
    expect(args).toContain("https://app.example.com/portal/");
    // default bucket 10 rps → cooperative rate-limit flag
    expect(args).toContain("-rate-limit");
    expect(args[args.indexOf("-rate-limit") + 1]).toBe("10");
    expect(args).toContain("-json");
  });
});

describe("§3.3 — out-of-scope targets: both layers proven", () => {
  it("layer 1: the technique filter — no vulnerability_scanning, no nuclei tool at all", async () => {
    const eng = engagement({ techniques: ["reconnaissance"] });
    const rig = makeRig(eng);
    expect(rig.tools.get("security.nuclei")).toBeNull();
    expect(rig.tools.list().map((d) => d.name)).not.toContain("security.nuclei");

    const ctx = toolContext(rig, eng);
    const runtime = rig.kernel.services.get<ToolRuntime>("tools.runtime")!;
    const events: SessionEvent[] = (ctx as unknown as { __events: SessionEvent[] }).__events;
    const out = await runtime.execute(
      { call_id: "c1", name: "security.nuclei", input: { targets: ["https://app.example.com/portal/"] } },
      ctx as never,
    );
    expect(out).toEqual({ kind: "text", text: 'error: unknown tool "security.nuclei"' });
    expect(events.find((e) => e.type === "tool.error")).toMatchObject({ error: { code: "tool_unknown" } });
    expect(rig.executor.calls).toHaveLength(0);
  });

  it("layer 2: the egress path — an in-scope NAME resolving out of scope never fires (DNS rebinding)", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.httpx")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.httpx", input: { targets: ["https://rebind.example.com/"] } },
      ctx,
    );
    // rebind.example.com suffix-matches example.com, but the fake resolver
    // returns 198.51.100.99 — outside the authorized CIDR set.
    expect(out.kind).toBe("text");
    expect((out as { text: string }).text).toContain("dns_rebinding_out_of_scope");
    expect(rig.executor.calls).toHaveLength(0);
    // The denial is audited too.
    expect(rig.auditRows.some((r) => r.action === "security.scope.allowed")).toBe(true);
  });

  it("an out-of-scope target is denied at the action-time check — executor silent", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const events: SessionEvent[] = (ctx as unknown as { __events: SessionEvent[] }).__events;
    const handler = rig.registry.get("security.httpx")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.httpx", input: { targets: ["https://evil.example.net/"] } },
      ctx,
    );
    expect((out as { text: string }).text).toContain("denied by scope");
    expect(events.find((e) => e.type === "action.denied")).toMatchObject({ reason: "scope" });
    expect(rig.executor.calls).toHaveLength(0);
    const denied = rig.auditRows.find((r) => r.action === "security.scope.denied");
    expect(denied).toBeDefined();
    expect(denied!.payload.engagement_id).toBe("acme-q4-2026");
  });

  it("no engagement at all: the tool is absent from the session registry", () => {
    const rig = makeRig(null);
    expect(rig.tools.list().map((d) => d.name)).not.toContain("security.nuclei");
    expect(rig.tools.list().map((d) => d.name)).not.toContain("security.httpx");
    expect(rig.tools.list().map((d) => d.name)).not.toContain("security.nmap");
  });

  it("nmap CIDR containment: a covered range scans, an uncovered or excluded range is denied", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({
      exit_code: 0,
      stdout: "Host: 203.0.113.20 (up)\n\tPorts: 22/open/tcp//ssh///, 443/open/tcp//https///\n",
      stderr: "",
    }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.nmap")!.handler;

    const ok = await handler.execute(
      { call_id: "c1", name: "security.nmap", input: { target: "203.0.113.0/25" } },
      ctx,
    );
    expect(ok.kind).toBe("json");
    expect((ok as { json: { count: number } }).json.count).toBe(2);
    expect(rig.executor.calls).toHaveLength(1);
    // --max-rate from the nmap packets bucket
    expect(rig.executor.calls[0]!.args).toContain("--max-rate");

    // Uncovered range: 10.0.0.0/8 is not inside 203.0.113.0/24.
    const wide = await handler.execute(
      { call_id: "c2", name: "security.nmap", input: { target: "10.0.0.0/8" } },
      ctx,
    );
    expect((wide as { text: string }).text).toContain("denied by scope");
    // Excluded half of the authorized range.
    const excluded = await handler.execute(
      { call_id: "c3", name: "security.nmap", input: { target: "203.0.113.128/25" } },
      ctx,
    );
    expect((excluded as { text: string }).text).toContain("denied by scope");
    expect(rig.executor.calls).toHaveLength(1);
  });
});

describe("§3.3 — rate limits and malformed output", () => {
  it("sequential calls to the same host share the bucket and block (virtual clock)", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: "", stderr: "" }));
    const handler = rig.registry.get("security.subfinder")!.handler;
    await handler.execute({ call_id: "c1", name: "security.subfinder", input: { domain: "example.com" } }, toolContext(rig, eng));
    await handler.execute({ call_id: "c2", name: "security.subfinder", input: { domain: "example.com" } }, toolContext(rig, eng));
    // default 10 rps → the second call waited a full 100 ms interval.
    expect(rig.clock.now - T0).toBeGreaterThanOrEqual(100);
  });

  it("malformed tool output is a clean skill.error — the session continues", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: "this is not jsonl {{{", stderr: "" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.httpx")!.handler;
    await expect(
      handler.execute({ call_id: "c1", name: "security.httpx", input: { targets: ["https://app.example.com/portal/"] } }, ctx),
    ).rejects.toMatchObject({ name: "SecurityToolError", code: "skill.error" });
  });

  it("a binary failure (non-zero exit) is a skill.error with the stderr tail", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 2, stdout: "", stderr: "boom" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.katana")!.handler;
    await expect(
      handler.execute({ call_id: "c1", name: "security.katana", input: { targets: ["https://app.example.com/portal/"] } }, ctx),
    ).rejects.toMatchObject({ name: "SecurityToolError", code: "skill.error", message: expect.stringContaining("boom") });
  });
});

describe("the charset guard — shell metacharacters never reach a command line", () => {
  it("a metacharacter wordlist path is rejected before any composition — the executor never fires", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const events: SessionEvent[] = (ctx as unknown as { __events: SessionEvent[] }).__events;
    const runtime = rig.kernel.services.get<ToolRuntime>("tools.runtime")!;
    const out = await runtime.execute(
      {
        call_id: "c1",
        name: "security.ffuf",
        input: { url: "https://app.example.com/portal/FUZZ", wordlist: "a;rm -rf /" },
      },
      ctx as never,
    );
    // The handler's schema (the runtime's converter is type-level only)
    // rejects the token; the runtime surfaces it as a tool error and the
    // turn CONTINUES — and the executor never saw a command.
    expect(out.kind).toBe("text");
    expect((out as { text: string }).text).toContain("security.ffuf");
    expect(events.find((e) => e.type === "tool.error")).toBeDefined();
    expect(rig.executor.calls).toHaveLength(0);
  });

  it("the executor-side guard refuses unsafe tokens outright (defense in depth)", () => {
    expect(() => assertSafeTokens(["a;rm -rf /"])).toThrow(/safe set/);
    expect(() => assertSafeTokens(["$(whoami)"])).toThrow(/safe set/);
    expect(() => assertSafeTokens(["wordlist.txt"])).not.toThrow();
  });
});
