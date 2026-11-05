// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.4 — the disclosure-workflow acceptance battery. The CVE
// services are injected as fixtures in the services' REAL response shapes
// (NVD 2.0 / OSV v1 / GHSA REST — see cve-fixtures.ts); minimize-poc's
// subset-only property is proven directly; submit-cve's R4 gate is tested
// both ways (approved → content, denied → nothing); the whole workflow runs
// end-to-end against one engagement. R2-5 and R2-8 carry dedicated
// regressions.

import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { openSessionStore } from "@nyx/session";
import { ToolRegistryImpl } from "@nyx/tools";
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
  SecurityRateLimiter,
  buildEngagementTooling,
  registerSecurityTools,
  clearSecurityToolMeta,
} from "../index.js";
import { minimizePocLines } from "./minimize-poc/index.js";
import type { JsonFetch } from "./cve_services.js";
import {
  GHSA_CVE_2021_41773,
  NVD_CVE_2021_41773,
  NVD_EMPTY,
  OSV_EMPTY,
  OSV_HTTPD,
} from "./cve-fixtures.js";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const stacks: Array<() => void> = [];
afterAll(() => {
  clearSecurityToolMeta();
  while (stacks.length > 0) stacks.pop()!();
});

function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return {
    id: "acme-q4-2026-exploit",
    operator_id: "owner",
    authorized_at: T0 - 86_400_000,
    expires_at: Date.now() + 86_400_000,
    targets: { domains: ["example.com"], cidrs: ["203.0.113.0/24"] },
    techniques: ["reconnaissance", "web_enumeration", "vulnerability_scanning", "exploitation"],
    rate_limits: { default: { requests_per_second: 10 } },
    client: "Acme Corp (authorized)",
    emergency_contact: "security@acme.example",
    ...overrides,
  };
}

interface Rig {
  store: FindingStore;
  registry: ToolRegistryImpl;
  kernel: ReturnType<typeof buildEngagementTooling>["kernel"];
  tools: ReturnType<typeof buildEngagementTooling>["tools"];
  files: Map<string, string>;
  auditRows: Array<{ actor: string; action: string; payload: Record<string, unknown> }>;
  ctx: (eng: Engagement | null) => ToolContext;
  approvals: { requested: number; decision: "allow" | "deny" };
}

function makeRig(
  eng: Engagement,
  opts: {
    fetchImpl?: JsonFetch;
    approvalDecision?: "allow" | "deny";
  } = {},
): Rig {
  const db = new Database(":memory:");
  openSessionStore(":memory:", { db });
  stacks.push(() => db.close());
  db.prepare(
    "INSERT OR REPLACE INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, engagement_json) VALUES (?, 'owner', 'default', 'test', ?, ?, ?)",
  ).run("sess-1", T0, T0, JSON.stringify(eng));

  const store = new FindingStore({ db, now: () => T0 });
  const auditRows: Rig["auditRows"] = [];
  const files = new Map<string, string>();
  const approvals = { requested: 0, decision: opts.approvalDecision ?? "allow" };
  const registry = new ToolRegistryImpl();
  registerSecurityTools(registry, {
    store,
    executor: {
      run: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
    },
    limiter: new SecurityRateLimiter({ now: () => T0, sleep: async () => undefined }),
    now: () => T0,
    audit: (r: { actor: string; action: string; payload: Record<string, unknown> }) =>
      auditRows.push(r),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  } as never);

  const policy: PolicyEngine = {
    async evaluate(req: { tool: string; risk: string }) {
      // Mirror the production invariant: R4 always asks.
      if (req.risk === "R4") {
        return {
          decision: "ask",
          rule_id: "invariant:r4-owner-approval",
          action_digest: "0".repeat(64),
          summary: `${req.tool} (r4 test)`,
        };
      }
      return {
        decision: "allow",
        rule_id: "test:allow",
        action_digest: "0".repeat(64),
        summary: `${req.tool} (test allow)`,
      };
    },
  } as never;
  const approvalEngine: ApprovalEngine = {
    request: async () => {
      approvals.requested += 1;
      return approvals.decision;
    },
    resolve: async () => undefined,
    get: async () => null,
    pending: async () => [],
    consume: async () => undefined,
  } as never;

  const fakeKernel = {
    version: "0-test",
    hooks: { on: () => () => {}, emit: async () => [] },
    tools: registry,
    services: new Map<string, unknown>(),
    use: async () => {},
    unuse: async () => {},
  } as never;
  const tooling = buildEngagementTooling(
    { tools: registry, kernel: fakeKernel, policy, approvals: approvalEngine } as never,
    eng,
  );
  const noopLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => noopLogger,
  };
  const sandbox: Sandbox = {
    id: "sbx-test",
    workdir: "/workspace",
    exec: async () => ({ exit_code: 0, stdout: "", stderr: "", duration_ms: 0, truncated: false }),
    readFile: async (p: string) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`no such file ${p}`);
      return Buffer.from(content, "utf8");
    },
    writeFile: (p: string, data: Buffer | string) => {
      files.set(p, typeof data === "string" ? data : data.toString("utf8"));
      return Promise.resolve();
    },
    list: async () => [],
    destroy: async () => {},
  };
  const ctx = (e: Engagement | null): ToolContext => {
    const events: SessionEvent[] = [];
    return {
      session_id: "sess-1",
      turn_id: "turn-1",
      call_id: "call-1",
      sandbox,
      signal: new AbortController().signal,
      logger: noopLogger,
      emit: (e2: SessionEvent) => events.push(e2),
      engagement: e,
    } as never;
  };
  return { store, registry, kernel: tooling.kernel, tools: tooling.tools, files, auditRows, ctx, approvals };
}

async function call(rig: Rig, name: string, input: unknown) {
  const runtime = rig.kernel.services.get<ToolRuntime>("tools.runtime")!;
  return runtime.execute({ call_id: "c1", name, input }, rig.ctx(engagement()) as never);
}

/** A fixture fetch serving the REAL shapes by URL. */
function fixtureFetch(overrides: Record<string, unknown> = {}): JsonFetch {
  return async (url: string) => {
    if (url in overrides) return overrides[url]!;
    if (url.startsWith("https://nvd.nist.gov/")) return NVD_CVE_2021_41773;
    if (url.startsWith("https://api.osv.dev/")) return OSV_HTTPD;
    if (url.startsWith("https://api.github.com/")) return GHSA_CVE_2021_41773;
    throw new Error(`unexpected url ${url}`);
  };
}

async function seedFinding(rig: Rig, overrides: Record<string, unknown> = {}) {
  return rig.store.createInSession(
    { session_id: "sess-1", engagement: engagement() },
    {
      title: "Path traversal in static file serving",
      description:
        "The web server maps URLs to files outside the document root via a path normalization flaw.",
      severity: "high",
      cvss_3_1: 7.5,
      target: { host: "app.example.com", path: "/icons/" },
      evidence: [{ path: "artifacts/poc.txt", hash: "a".repeat(64), mime: "text/plain" }],
      reproduction:
        "GET /icons/../../../etc/passwd HTTP/1.1\nHost: app.example.com\nAccept: */*\nUser-Agent: nyx\nConnection: close\n",
      remediation: "Upgrade the affected server; normalize paths before file mapping.",
      status: "open",
      discovered_by: "test",
      notes: "",
      ...overrides,
    } as never,
  );
}

// ---------------------------------------------------------------------------
// correlate-cve (§4.4)
// ---------------------------------------------------------------------------

describe("correlate-cve — the acceptance cases", () => {
  it("Apache httpd 2.4.49 path traversal → CVE-2021-41773 with exact-match confidence, written back to the finding", async () => {
    const eng = engagement();
    const rig = makeRig(eng, { fetchImpl: fixtureFetch() });
    const finding = await seedFinding(rig);
    const out = await call(rig, "security.correlate-cve", {
      finding_id: finding.id,
      product: "Apache httpd",
      version: "2.4.49",
      vuln_terms: ["path traversal"],
    });
    const json = (out as { json: { cves: string[]; confidence: string; result: string } }).json;
    expect(json.result).toBe("match");
    expect(json.cves).toContain("CVE-2021-41773");
    expect(json.confidence).toBe("exact-match");
    // Written back to the finding.
    const updated = await rig.store.get(finding.id);
    expect(updated!.cve).toContain("CVE-2021-41773");
    // The research queries are audit-logged with the fixed hosts.
    const row = rig.auditRows.find((r) => r.action === "security.cve.query");
    expect(row).toBeDefined();
    expect(JSON.stringify(row!.payload)).toContain("nvd.nist.gov");
    expect(JSON.stringify(row!.payload)).toContain("api.osv.dev");
  });

  it("a known-vulnerable version with no matching CVE in the DBs: no_match with an empty list", async () => {
    const eng = engagement();
    const rig = makeRig(eng, {
      fetchImpl: fixtureFetch({
        "https://nvd.nist.gov/rest/json/cves/2.0?keywordSearch=Acme%20Portal%20xml%20injection": NVD_EMPTY,
        "https://api.osv.dev/v1/query": OSV_EMPTY,
        "https://api.github.com/advisories?cve_id=": [],
      }),
    });
    const finding = await seedFinding(rig, { title: "XXE in the Acme Portal" });
    const out = await call(rig, "security.correlate-cve", {
      finding_id: finding.id,
      product: "Acme Portal",
      version: "3.2.1",
      vuln_terms: ["xml injection"],
    });
    const json = (out as { json: { cves: string[]; result: string } }).json;
    expect(json.result).toBe("no_match");
    expect(json.cves).toEqual([]);
    // No CVE written back.
    const updated = await rig.store.get(finding.id);
    expect(updated!.cve).toBeUndefined();
  });

  it("a foreign finding (another engagement) is denied", async () => {
    const eng = engagement();
    const rig = makeRig(eng, { fetchImpl: fixtureFetch() });
    const other = engagement({ id: "ENG-OTHER" });
    // A second session in the SAME store, bound to another engagement.
    const db = (rig as unknown as { store: { db: Database.Database } }).store.db;
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, engagement_json) VALUES ('sess-other', 'owner', 'default', 't', ?, ?, ?)",
    ).run(T0, T0, JSON.stringify({ id: "ENG-OTHER" }));
    const otherFinding = await rig.store.createInSession(
      { session_id: "sess-other", engagement: other },
      {
        title: "t",
        description: "d",
        severity: "low",
        target: { host: "x" },
        evidence: [],
        reproduction: "r",
        remediation: "r",
        status: "open",
        discovered_by: "t",
        notes: "",
      } as never,
    );
    const out = await call(rig, "security.correlate-cve", {
      finding_id: otherFinding.id,
      product: "Apache httpd",
    });
    expect(((out as { text?: string }).text ?? "")).toContain("engagement");
  });
});

// ---------------------------------------------------------------------------
// minimize-poc (§4.4)
// ---------------------------------------------------------------------------

describe("minimize-poc — subset-only reduction", () => {
  const twelveLinePoc = [
    "GET /icons/../../../etc/passwd HTTP/1.1",
    "Host: app.example.com",
    "Accept: */*",
    "Accept-Language: en-US",
    "User-Agent: nyx-probe",
    "Connection: close",
    "X-Request-Id: deadbeef",
    "X-Debug: true",
    "Cookie: session=abc",
    "Referer: https://app.example.com/",
    "",
    "",
  ].join("\n");

  it("a 12-line request reduces under 12 lines; the output is a strict SUBSET of the input", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig, { reproduction: twelveLinePoc });
    const out = await call(rig, "security.minimize-poc", {
      finding_id: finding.id,
      required_tokens: ["/icons/../../../etc/passwd", "Host:"],
    });
    const json = (out as { json: { result: string; original_lines: number; minimized_lines: number; minimized_poc: string } }).json;
    expect(json.result).toBe("minimized");
    expect(json.original_lines).toBe(12);
    expect(json.minimized_lines!).toBeLessThan(12);
    // Subset property: every output line appears in the input, verbatim.
    const inputLines = twelveLinePoc.split("\n");
    for (const line of json.minimized_poc!.split("\n")) {
      expect(inputLines).toContain(line);
    }
    // The trigger survives; the noise is gone.
    expect(json.minimized_poc).toContain("/icons/../../../etc/passwd");
    expect(json.minimized_poc).not.toContain("User-Agent");
  });

  it("an already-minimal PoC returns cannot_minimize (never fabricates a smaller one)", async () => {
    const minimal = "GET /icons/../../../etc/passwd HTTP/1.1\nHost: app.example.com\n";
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig, { reproduction: minimal });
    const out = await call(rig, "security.minimize-poc", {
      finding_id: finding.id,
      required_tokens: ["/icons/../../../etc/passwd", "Host:"],
    });
    const json = (out as { json: { result: string; note: string } }).json;
    expect(json.result).toBe("cannot_minimize");
    expect(json.note).toContain("fabricate");
  });

  it("empty required_tokens is refused — the reduction would be meaningless", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig);
    const out = await call(rig, "security.minimize-poc", { finding_id: finding.id });
    expect(((out as { text?: string }).text ?? "")).toContain("required_tokens");
  });

  it("the reducer unit: payload lines survive, unrelated lines go, verbatim", () => {
    const poc = "GET /x HTTP/1.1\nHost: h\nJunk: 1\nPayload: <script>alert(1)</script>\n";
    const result = minimizePocLines(poc, ["<script>alert(1)</script>"]);
    expect(result.result).toBe("minimized");
    expect(result.minimized_poc).toBe("GET /x HTTP/1.1\nHost: h\nPayload: <script>alert(1)</script>\n");
    expect(result.removed).toEqual(["Junk: 1"]);
  });
});

// ---------------------------------------------------------------------------
// prepare-disclosure + submit-cve (§4.4)
// ---------------------------------------------------------------------------

describe("prepare-disclosure — the package", () => {
  it("produces repro, impact, versions, timeline, email; hashes recorded in the audit chain", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig);
    const out = await call(rig, "security.prepare-disclosure", {
      finding_id: finding.id,
      affected_versions: ["2.4.49", "2.4.50"],
      vendor_contact: "security@vendor.example",
      impact: "An unauthenticated attacker reads files outside the document root.",
    });
    const json = (out as { json: { directory: string; manifest: string; sha256: string; files: Array<{ name: string; sha256: string }> } }).json;
    expect(json.directory).toBe(`disclosures/${finding.id}`);
    const names = json.files.map((f) => f.name);
    expect(names).toContain("reproduction.md");
    expect(names).toContain("impact.md");
    expect(names).toContain("versions.md");
    expect(names).toContain("timeline.md");
    expect(names).toContain("email.md");
    // The manifest hash matches its content on disk.
    const manifestRaw = rig.files.get(json.manifest)!;
    expect(json.sha256).toBe(createHash("sha256").update(manifestRaw).digest("hex"));
    // Timeline: the 90-day default.
    expect(rig.files.get(`${json.directory}/timeline.md`)).toContain("90 days");
    // The email draft carries the vendor contact.
    expect(rig.files.get(`${json.directory}/email.md`)).toContain("security@vendor.example");
    // Every file's hash verifies.
    for (const f of json.files) {
      const content = rig.files.get(`${json.directory}/${f.name}`)!;
      expect(f.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    }
    // Audit row.
    const row = rig.auditRows.find((r) => r.action === "security.disclosure.prepared");
    expect(row).toBeDefined();
    expect(row!.payload.sha256).toBe(json.sha256);
  });
});

describe("submit-cve — R4, content only, never an automatic submission", () => {
  async function preparedRig() {
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig);
    await call(rig, "security.prepare-disclosure", {
      finding_id: finding.id,
      affected_versions: ["2.4.49"],
      vendor_contact: "security@vendor.example",
      impact: "impact statement",
    });
    return { rig, finding };
  }

  it("with the owner's approval: produces MITRE-ready form content; no network path exists", async () => {
    const { rig, finding } = await preparedRig();
    const out = await call(rig, "security.submit-cve", {
      finding_id: finding.id,
      package_dir: `disclosures/${finding.id}`,
      researcher_contact: "researcher@example.com",
    });
    expect(rig.approvals.requested).toBe(1); // R4 asked
    const json = (out as { json: { form_path: string; form: string; next_step: string } }).json;
    expect(json.form).toContain("REQUEST TYPE: Request a CVE ID");
    expect(json.form).toContain("AFFECTED VERSIONS: 2.4.49");
    expect(json.form).toContain("researcher@example.com");
    expect(json.next_step).toContain("cveform.mitre.org");
    expect(rig.files.get(json.form_path)).toBe(json.form);
    // The tool declares NO network capability — submission is a human step.
    const def = rig.registry.get("security.submit-cve")!;
    expect(def.def.capabilities).toEqual([]);
    // Audit row records the R4-approved production.
    expect(rig.auditRows.some((r) => r.action === "security.cve.request_prepared")).toBe(true);
  });

  it("WITHOUT approval: the R4 gate denies and NO form is produced", async () => {
    const { rig, finding } = await preparedRig();
    rig.approvals.decision = "deny";
    const out = await call(rig, "security.submit-cve", {
      finding_id: finding.id,
      package_dir: `disclosures/${finding.id}`,
      researcher_contact: "researcher@example.com",
    });
    expect(rig.approvals.requested).toBe(1);
    const text = (out as { text?: string }).text ?? JSON.stringify(out);
    expect(text).toContain("denied");
    // Nothing was written.
    expect([...rig.files.keys()].filter((k) => k.includes("cve-request"))).toEqual([]);
    expect(rig.auditRows.some((r) => r.action === "security.cve.request_prepared")).toBe(false);
  });

  it("refuses without a prepared package", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    const finding = await seedFinding(rig);
    const out = await call(rig, "security.submit-cve", {
      finding_id: finding.id,
      package_dir: "disclosures/does-not-exist",
      researcher_contact: "r@example.com",
    });
    expect(((out as { text?: string }).text ?? "")).toContain("prepare-disclosure");
  });
});

// ---------------------------------------------------------------------------
// The end-to-end workflow (§4.4) + the residual regressions
// ---------------------------------------------------------------------------

describe("the whole workflow — a synthetic finding through correlate → minimize → prepare → R4 submit", () => {
  it("runs end to end against one engagement", async () => {
    const eng = engagement();
    const rig = makeRig(eng, { fetchImpl: fixtureFetch() });
    const finding = await seedFinding(rig);

    const correlated = await call(rig, "security.correlate-cve", {
      finding_id: finding.id,
      product: "Apache httpd",
      version: "2.4.49",
      vuln_terms: ["path traversal"],
    });
    expect((correlated as { json: { cves: string[] } }).json.cves).toContain("CVE-2021-41773");

    const minimized = await call(rig, "security.minimize-poc", {
      finding_id: finding.id,
      poc: "GET /icons/../../../etc/passwd HTTP/1.1\nHost: app.example.com\nAccept: */*\n",
      required_tokens: ["/icons/../../../etc/passwd", "Host:"],
    });
    expect((minimized as { json: { result: string } }).json.result).toBe("minimized");

    const prepared = await call(rig, "security.prepare-disclosure", {
      finding_id: finding.id,
      affected_versions: ["2.4.49"],
      vendor_contact: "security@vendor.example",
      impact: "Unauthenticated file disclosure outside the document root.",
    });
    const dir = (prepared as { json: { directory: string } }).json.directory;

    const submitted = await call(rig, "security.submit-cve", {
      finding_id: finding.id,
      package_dir: dir,
      researcher_contact: "researcher@example.com",
    });
    expect(rig.approvals.requested).toBe(1);
    expect((submitted as { json: { form: string } }).json.form).toContain("CVE");
    // The finding now carries the correlated CVE for the report.
    const final = await rig.store.get(finding.id);
    expect(final!.cve).toContain("CVE-2021-41773");
  });
});

describe("R2-5 / R2-8 regressions", () => {
  it("R2-5: create() refuses fabricated sessions and mismatched engagements", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    await expect(
      rig.store.create({
        engagement_id: "acme-q4-2026-exploit",
        session_id: "sess-ghost",
        title: "t",
        description: "d",
        severity: "low",
        target: { host: "x" },
        evidence: [],
        reproduction: "r",
        remediation: "r",
        status: "open",
        discovered_by: "t",
        notes: "",
      }),
    ).rejects.toMatchObject({ code: "unknown_session" });

    const db = (rig as unknown as { store: { db: Database.Database } }).store.db;
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, engagement_json) VALUES ('sess-mismatch', 'owner', 'default', 't', 1, 1, ?)",
    ).run(JSON.stringify({ id: "ENG-SOMETHING-ELSE" }));
    await expect(
      rig.store.create({
        engagement_id: "acme-q4-2026-exploit",
        session_id: "sess-mismatch",
        title: "t",
        description: "d",
        severity: "low",
        target: { host: "x" },
        evidence: [],
        reproduction: "r",
        remediation: "r",
        status: "open",
        discovered_by: "t",
        notes: "",
      }),
    ).rejects.toMatchObject({ code: "engagement_mismatch" });
  });

  it("R2-8: the MARKDOWN report HTML-escapes finding-controlled text", async () => {
    const eng = engagement();
    const rig = makeRig(eng);
    await rig.store.createInSession(
      { session_id: "sess-1", engagement: engagement() },
      {
        title: "<script>alert('xss')</script> in the portal",
        description: "The <img src=x onerror=alert(1)> parameter is echoed.",
        severity: "medium",
        target: { host: "app.example.com" },
        evidence: [{ path: "x.txt", hash: createHash("sha256").update("evidence bytes").digest("hex"), mime: "text/plain" }],
        reproduction: "GET /?<script> HTTP/1.1",
        remediation: "Encode on output.",
        status: "open",
        discovered_by: "test",
        notes: "",
      } as never,
    );
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "nyx-r28-"));
    writeFileSync(join(root, "x.txt"), "evidence bytes");
    const { generateReport } = await import("../reports/generator.js");
    const rendered = await generateReport({
      engagement: engagement(),
      findings: await rig.store.list({ engagement_id: engagement().id }),
      evidence_root: root,
      format: "markdown",
      now: () => T0,
    });
    rmSync(root, { recursive: true, force: true });
    expect(rendered.content).not.toContain("<script>alert");
    expect(rendered.content).toContain("&lt;script&gt;alert('xss')&lt;/script&gt;");
    expect(rendered.content).not.toContain("<img src=x");
  });
});
