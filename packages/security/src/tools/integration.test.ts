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
  SandboxSecurityExecutor,
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
  resolvedHosts: string[];
  registry: ToolRegistryImpl;
  kernel: ReturnType<typeof buildEngagementTooling>["kernel"];
  tools: ReturnType<typeof buildEngagementTooling>["tools"];
  limiterBucketCount: () => number;
}

function makeRig(eng: Engagement | null): Rig {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  openSessionStore(":memory:", { db });
  stacks.push(() => db.close());
  // R2-5: create()/createInSession verify the session row; seed it.
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, engagement_json) VALUES (?, 'owner', 'default', 'test', ?, ?, ?)",
  ).run("sess-1", T0, T0, JSON.stringify(eng));

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
  // Fake DNS: in-scope names resolve into the authorized CIDR. The resolved
  // hostnames are recorded (R1-7: bracketed IPv6 must reach the resolver
  // normalized, not as "[2001:db8::1]").
  const resolvedHosts: string[] = [];
  const resolver = new DnsEgressResolver({
    now: () => clock.now,
    lookup: async (host: string) => {
      resolvedHosts.push(host);
      if (host === "rebind.example.com") return [{ address: "198.51.100.99", family: 4 }];
      if (host === "2001:db8::1") return [{ address: "2001:db8::1", family: 6 }];
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
  return {
    executor,
    store,
    auditRows,
    clock,
    files,
    resolvedHosts,
    registry,
    kernel: tooling.kernel,
    tools: tooling.tools,
    limiterBucketCount: () => limiter.bucketCount,
  };
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
    // REAL nuclei -jsonl format: dashed keys, array cve-id/cwe-id (R3-4).
    const nucleiJsonl = [
      JSON.stringify({
        "template-id": "cve-2026-1234",
        info: {
          name: "Example Reflected XSS",
          severity: "high",
          description: "Reflected XSS in the q parameter.",
          classification: { "cve-id": ["CVE-2026-1234"], "cwe-id": ["79"], "cvss-metrics": "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
        },
        "matched-at": "https://app.example.com/portal/login",
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
    // Targets ride -u flags — goflags drops positional args (R3-1).
    expect(args).toContain("-u");
    expect(args[args.indexOf("-u") + 1]).toBe("https://app.example.com/portal/");
    expect(args.filter((a) => a === "-u")).toHaveLength(1);
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
    // REAL greppable format: Ports is a TAB field on the Host line (R3-5).
    rig.executor.respondWith(() => ({
      exit_code: 0,
      stdout: "Host: 203.0.113.20 (up)\tPorts: 22/open/tcp//ssh///, 443/open/tcp//https///\tIgnored State: closed (998)\n",
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

describe("the two-reviewer fan-out regressions (tool layer)", () => {
  it("R1-1 (HIGH): ffuf wordlist traversal — absolute paths and .. segments are refused", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.ffuf")!.handler;
    for (const wordlist of ["/etc/passwd", "../../.ssh/id_rsa", "wordlists/../../etc/passwd"]) {
      await expect(
        handler.execute(
          { call_id: "c1", name: "security.ffuf", input: { url: "https://app.example.com/portal/FUZZ", wordlist } },
          ctx,
        ),
      ).rejects.toThrow();
    }
    expect(rig.executor.calls).toHaveLength(0);
  });

  it("R1-1: a legitimate workspace-relative wordlist still fires", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: '{"results":[]}', stderr: "" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.ffuf")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.ffuf", input: { url: "https://app.example.com/portal/FUZZ", wordlist: "wordlists/common.txt" } },
      ctx,
    );
    expect(out.kind).toBe("json");
    expect(rig.executor.calls[0]!.args).toContain("wordlists/common.txt");
  });

  it("R1-3: a call that sleeps past the engagement window never fires", async () => {
    const eng = engagement({ expires_at: T0 + 150, rate_limits: { default: { requests_per_second: 10 } } });
    const rig = makeRig(eng);
    const handler = rig.registry.get("security.subfinder")!.handler;
    // First call charges the shared default bucket (next allowed at +100ms).
    await handler.execute({ call_id: "c1", name: "security.subfinder", input: { domain: "example.com" } }, toolContext(rig, eng));
    expect(rig.executor.calls).toHaveLength(1);
    // Second call sleeps to T0+200, past expires_at (T0+150) — denied, executor silent.
    const out = await handler.execute({ call_id: "c2", name: "security.subfinder", input: { domain: "example.com" } }, toolContext(rig, eng));
    expect((out as { text: string }).text).toContain("expired");
    expect(rig.executor.calls).toHaveLength(1);
  });

  it("R1-4: trailing-dot host variants share ONE rate bucket", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const handler = rig.registry.get("security.subfinder")!.handler;
    await handler.execute({ call_id: "c1", name: "security.subfinder", input: { domain: "example.com" } }, toolContext(rig, eng));
    await handler.execute({ call_id: "c2", name: "security.subfinder", input: { domain: "example.com." } }, toolContext(rig, eng));
    // Same bucket (10 rps): the second call waited a full interval — not a
    // fresh bucket, which would not have waited at all.
    expect(rig.clock.now - T0).toBeGreaterThanOrEqual(100);
    expect(rig.limiterBucketCount()).toBe(1);
  });

  it("R1-5: the engagement view flows into child tooling (the tasks-path mechanism)", () => {
    const eng = engagement({ techniques: ["reconnaissance"] });
    const rig = makeRig(eng);
    // A child-style allowlist view over the session's engagement view: the
    // child asks for security.nuclei by name, but the parent view already
    // filtered it — absence is inherited, exactly as buildChildTooling
    // composes views (the server's taskContextFor now wraps the same way).
    const allowlist = new Set(["security.nuclei", "security.httpx", "fs.read"]);
    const childView = {
      list: () => rig.tools.list().filter((d) => allowlist.has(d.name)),
      get: (name: string) => (allowlist.has(name) ? rig.tools.get(name) : null),
    };
    expect(childView.get("security.nuclei")).toBeNull();
    expect(childView.list().map((d) => d.name)).toEqual([]);
  });

  it("R1-6/#11: URL query strings pass the charset and the sandbox composition quotes every token", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const commands: string[] = [];
    const sandbox = fakeSandbox(rig);
    const sandboxExec = sandbox.exec as unknown as (cmd: string, opts?: unknown) => Promise<{ exit_code: number; stdout: string; stderr: string }>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (sandbox as any).exec = async (cmd: string, opts?: unknown) => {
      commands.push(cmd);
      return sandboxExec(cmd, opts as never);
    };
    const executor = new SandboxSecurityExecutor(sandbox);
    await executor.run("httpx", ["-json", "https://app.example.com/portal/login?q=1&x=2#frag"]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("'https://app.example.com/portal/login?q=1&x=2#frag'");
    // And the strict guard still refuses metacharacters.
    await expect(executor.run("sh", ["-c", "rm -rf /"])).rejects.toMatchObject({ code: "charset" });
  });

  it("R1-7: an IPv6-literal target reaches the resolver UNBRACKETED", async () => {
    const eng = engagement({ targets: { domains: [], cidrs: ["2001:db8::/32"], urls: [] } });
    const rig = makeRig(eng);
    const handler = rig.registry.get("security.httpx")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.httpx", input: { targets: ["https://[2001:db8::1]/portal/"] } },
      toolContext(rig, eng),
    );
    expect(out.kind).toBe("json");
    expect(rig.resolvedHosts).toContain("2001:db8::1");
    expect(rig.resolvedHosts.every((h) => !h.startsWith("["))).toBe(true);
  });

  it("R1-9: an nmap CIDR with host bits set is refused", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.nmap")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.nmap", input: { target: "203.0.113.42/25" } },
      ctx,
    );
    expect((out as { text: string }).text).toContain("host bits set");
    expect(rig.executor.calls).toHaveLength(0);
  });

  it("R2-10: one malformed CVSS vector does not abort the remaining nuclei matches", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const stdout = [
      JSON.stringify({
        "template-id": "good-template",
        info: { name: "Good finding", severity: "high", classification: { "cvss-metrics": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" } },
        "matched-at": "https://app.example.com/portal/login",
      }),
      JSON.stringify({
        "template-id": "bad-vector",
        info: { name: "Bad vector", severity: "medium", classification: { "cvss-metrics": "CVSS:9.9/AV:N" } },
        "matched-at": "https://app.example.com/portal/x",
      }),
    ].join("\n");
    rig.executor.respondWith(() => ({ exit_code: 0, stdout, stderr: "" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.nuclei")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.nuclei", input: { targets: ["https://app.example.com/portal/login"] } },
      ctx,
    );
    const json = (out as { json: { count: number } }).json;
    expect(json.count).toBe(2);
    const findings = await rig.store.list({ engagement_id: eng.id });
    expect(findings).toHaveLength(2);
    const good = findings.find((f) => f.title === "Good finding")!;
    expect(good.cvss_3_1).toBe(9.8);
    const bad = findings.find((f) => f.title === "Bad vector")!;
    expect(bad.cvss_3_1).toBeUndefined();
  });
});

describe("R3 regressions — real binary invocation and output formats", () => {
  it("R3-6/#7: ffuf uses -json JSONL records and dotted extensions", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({
      exit_code: 0,
      stdout: 'admin\n{"url":"https://app.example.com/portal/admin","status":200,"length":512,"words":40}\n',
      stderr: "",
    }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.ffuf")!.handler;
    const out = await handler.execute(
      {
        call_id: "c1",
        name: "security.ffuf",
        input: { url: "https://app.example.com/portal/FUZZ", wordlist: "wordlists/common.txt", extensions: ["php"] },
      },
      ctx,
    );
    const json = (out as { json: { hits: Array<{ url: string; status: number | null }>; count: number } }).json;
    expect(json.count).toBe(1);
    expect(json.hits[0]!.url).toBe("https://app.example.com/portal/admin");
    expect(json.hits[0]!.status).toBe(200);
    const args = rig.executor.calls[0]!.args;
    expect(args).toContain("-json");
    expect(args).not.toContain("/dev/stdout");
    // The dotless "php" input is normalized to ".php".
    expect(args[args.indexOf("-e") + 1]).toBe(".php");
  });

  it("R3-2: nuclei targets ride repeated -u flags", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: "", stderr: "" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.nuclei")!.handler;
    await handler.execute(
      {
        call_id: "c1",
        name: "security.nuclei",
        input: { targets: ["https://app.example.com/portal/a", "https://app.example.com/portal/b"] },
      },
      ctx,
    );
    const args = rig.executor.calls[0]!.args;
    expect(args.filter((a) => a === "-u")).toHaveLength(2);
    expect(args).toContain("https://app.example.com/portal/a");
    expect(args).toContain("https://app.example.com/portal/b");
  });

  it("R3-3/#14: katana targets ride -u and only http(s) URL lines count", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({
      exit_code: 0,
      stdout: "https://app.example.com/portal/a\n[WARN] some noise\nhttps://app.example.com/portal/b\n",
      stderr: "",
    }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.katana")!.handler;
    const out = await handler.execute(
      { call_id: "c1", name: "security.katana", input: { targets: ["https://app.example.com/portal/"] } },
      ctx,
    );
    const json = (out as { json: { urls: string[]; count: number } }).json;
    expect(json.urls).toEqual(["https://app.example.com/portal/a", "https://app.example.com/portal/b"]);
    expect(rig.executor.calls[0]!.args).toContain("-u");
  });

  it("R3-11: nmap derives a conservative --max-rate from the default request rate", async () => {
    const eng = engagement({ rate_limits: { default: { requests_per_second: 10 } } });
    const rig = makeRig(eng);
    rig.executor.respondWith(() => ({ exit_code: 0, stdout: "", stderr: "" }));
    const ctx = toolContext(rig, eng);
    const handler = rig.registry.get("security.nmap")!.handler;
    await handler.execute({ call_id: "c1", name: "security.nmap", input: { target: "203.0.113.20" } }, ctx);
    const args = rig.executor.calls[0]!.args;
    expect(args).toContain("--max-rate");
    expect(args[args.indexOf("--max-rate") + 1]).toBe("10");
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
