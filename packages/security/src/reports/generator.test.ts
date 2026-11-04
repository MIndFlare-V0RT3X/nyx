// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Engagement } from "@nyx/protocol";
import type { Finding } from "../findings/schema.js";
import { generateReport, OutOfScopeFindingError } from "./generator.js";
import { verifyEvidence } from "./evidence.js";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

const stacks: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (stacks.length > 0) await stacks.pop()!();
});

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  stacks.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function engagement(): Engagement {
  return {
    id: "acme-q4-2026",
    title: "Acme Corp",
    operator_id: "owner",
    authorized_at: Date.UTC(2026, 10, 1),
    starts_at: Date.UTC(2026, 10, 1),
    expires_at: Date.UTC(2026, 11, 1),
    targets: {
      domains: ["example.com"],
      cidrs: ["203.0.113.0/24"],
      urls: ["https://app.example.com/portal/*"],
      exclude: { domains: ["mail.example.com"], cidrs: ["203.0.113.128/25"] },
    },
    techniques: ["reconnaissance", "web_enumeration", "vulnerability_scanning"],
    client: "Acme Corp",
    authorized_by: "Jane Smith, CISO",
    emergency_contact: "security@acme.example",
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    engagement_id: "acme-q4-2026",
    session_id: "sess-1",
    title: "Reflected XSS in the portal login form",
    description: "The q parameter is echoed unescaped into the login page HTML.",
    severity: "medium",
    cvss_3_1: 6.1,
    cwe: ["CWE-79"],
    target: { host: "app.example.com", port: 443, path: "/portal/login" },
    evidence: [],
    reproduction: "1. Open /portal/login?q=<script> 2. Observe the alert",
    remediation: "HTML-encode the q parameter on output.",
    status: "open",
    discovered_at: NOW - 3_600_000,
    discovered_by: "nuclei/security.nuclei",
    notes: "",
    ...overrides,
  };
}

async function evidenceDir(): Promise<{ root: string; artifact: Finding["evidence"] }> {
  const root = await tmpDir("nyx-report-ev-");
  await writeFile(path.join(root, "xss-poc.txt"), "GET /portal/login?q=<script>alert(1)</script>", "utf8");
  const hash = createHash("sha256").update(readFileSync(path.join(root, "xss-poc.txt"))).digest("hex");
  return {
    root,
    artifact: [{ path: "xss-poc.txt", hash, mime: "text/plain" }],
  };
}

describe("generateReport — the scope gate (§2.4)", () => {
  it("an out-of-scope finding aborts generation and writes NO file", async () => {
    const root = await tmpDir("nyx-report-gate-");
    const out = path.join(root, "report.md");
    const findings = [
      finding(),
      finding({ id: "f-evil", title: "Hostile finding", target: { host: "evilcorp.example.net" } }),
    ];
    await expect(
      generateReport({ engagement: engagement(), findings, evidence_root: root, format: "markdown", out_path: out, now: () => NOW }),
    ).rejects.toBeInstanceOf(OutOfScopeFindingError);
    expect(existsSync(out)).toBe(false);
  });

  it("an excluded target is out of scope even inside an authorized range", async () => {
    const root = await tmpDir("nyx-report-gate2-");
    await expect(
      generateReport({
        engagement: engagement(),
        findings: [finding({ id: "f-ex", target: { host: "203.0.113.200" } })],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ name: "OutOfScopeFindingError" });
  });

  it("the error names the finding, the target, and the reason", async () => {
    const root = await tmpDir("nyx-report-gate3-");
    const err = await generateReport({
      engagement: engagement(),
      findings: [finding({ id: "f-oos", target: { host: "evil.example.net" } })],
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OutOfScopeFindingError);
    const oos = err as OutOfScopeFindingError;
    expect(oos.finding_id).toBe("f-oos");
    expect(oos.target).toBe("evil.example.net");
    expect(oos.reason).toContain("not in engagement scope");
  });

  it("a URL-target finding under an authorized path passes; a sibling path does not", async () => {
    const root = await tmpDir("nyx-report-gate4-");
    const ok = await generateReport({
      engagement: { ...engagement(), targets: { domains: [], cidrs: [], urls: ["https://app.example.com/portal/*"] } },
      findings: [finding({ target: { host: "app.example.com", path: "/portal/login" } })],
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    });
    expect(ok.findings_included).toBe(1);
    await expect(
      generateReport({
        engagement: { ...engagement(), targets: { domains: [], cidrs: [], urls: ["https://app.example.com/portal/*"] } },
        findings: [finding({ target: { host: "app.example.com", path: "/admin/login" } })],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toBeInstanceOf(OutOfScopeFindingError);
  });
});

describe("generateReport — the evidence gate (§2.4)", () => {
  it("evidence hashes are verified against disk and embedded in the report", async () => {
    const { root, artifact } = await evidenceDir();
    const out = path.join(root, "report.md");
    const report = await generateReport({
      engagement: engagement(),
      findings: [finding({ evidence: artifact })],
      evidence_root: root,
      format: "markdown",
      out_path: out,
      now: () => NOW,
    });
    expect(report.written_to).toBe(out);
    const content = await readFile(out, "utf8");
    expect(content).toContain(artifact[0]!.hash);
    expect(content).toContain("xss-poc.txt");
  });

  it("a tampered artifact aborts the report (hash mismatch)", async () => {
    const { root, artifact } = await evidenceDir();
    await writeFile(path.join(root, "xss-poc.txt"), "tampered", "utf8");
    await expect(
      generateReport({
        engagement: engagement(),
        findings: [finding({ evidence: artifact })],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ name: "EvidenceError", code: "hash_mismatch" });
  });

  it("a missing artifact aborts the report", async () => {
    const root = await tmpDir("nyx-report-miss-");
    await expect(
      generateReport({
        engagement: engagement(),
        findings: [finding({ evidence: [{ path: "gone.txt", hash: "0".repeat(64), mime: "text/plain" }] })],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "missing" });
  });

  it("a path escaping the workspace aborts the report", async () => {
    const root = await tmpDir("nyx-report-esc-");
    await expect(
      verifyEvidence(root, [{ path: "../../etc/passwd", hash: "0".repeat(64), mime: "text/plain" }]),
    ).rejects.toMatchObject({ code: "escape" });
  });
});

describe("generateReport — markdown (§2.4)", () => {
  it("renders with correct severity ordering and the exact engagement id + window", async () => {
    const root = await tmpDir("nyx-report-md-");
    const report = await generateReport({
      engagement: engagement(),
      findings: [
        finding({ id: "low", severity: "low", title: "Low finding" }),
        finding({ id: "crit", severity: "critical", title: "Critical finding", cvss_4_0: 9.4 }),
        finding({ id: "high", severity: "high", title: "High finding", cvss_3_1: 8.3 }),
        finding({ id: "crit2", severity: "critical", title: "Older critical", cvss_4_0: 9.0, discovered_at: NOW - 7_200_000 }),
      ],
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    });
    const c = report.content;
    // Severity ordering: critical (cvss desc) before high before low.
    const positions = ["Critical finding", "Older critical", "High finding", "Low finding"].map(
      (t) => c.indexOf(t),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Engagement id + exact window (hard rule #6).
    expect(c).toContain("acme-q4-2026");
    expect(c).toContain(new Date(Date.UTC(2026, 10, 1)).toISOString());
    expect(c).toContain(new Date(Date.UTC(2026, 11, 1)).toISOString());
    expect(c).toContain("Jane Smith, CISO");
    // All the §2.3 sections.
    for (const section of [
      "## Executive Summary",
      "## Scope Statement",
      "## Methodology",
      "## Findings",
      "## Evidence",
      "## Remediation Summary",
      "## Appendix",
    ]) {
      expect(c).toContain(section);
    }
  });
});

describe("generateReport — html (§2.4)", () => {
  it("is self-contained: no external asset fetches, inline styles only", async () => {
    const root = await tmpDir("nyx-report-html-");
    const report = await generateReport({
      engagement: engagement(),
      findings: [finding()],
      evidence_root: root,
      format: "html",
      now: () => NOW,
    });
    const c = report.content;
    expect(c).toContain("<!DOCTYPE html>");
    expect(c).toContain("<style>");
    // No external fetches: no link tags, no src attributes, no @import, no
    // href to stylesheets/scripts (mailto: in contact text is fine).
    expect(c).not.toMatch(/<link[\s>]/i);
    expect(c).not.toMatch(/\ssrc=/i);
    expect(c).not.toMatch(/@import/i);
    expect(c).not.toMatch(/<script[\s>]/i);
  });

  it("escapes finding-controlled content (the report itself is not an XSS vector)", async () => {
    const root = await tmpDir("nyx-report-xss-");
    const report = await generateReport({
      engagement: engagement(),
      findings: [
        finding({
          title: '</h3><script>alert("report")</script>',
          description: "<img src=x onerror=alert(1)>",
          notes: `"><svg onload=alert(2)>`,
        }),
      ],
      evidence_root: root,
      format: "html",
      now: () => NOW,
    });
    expect(report.content).not.toMatch(/<script[\s>]/i);
    expect(report.content).not.toMatch(/<img\s/i);
    expect(report.content).not.toMatch(/<svg/i);
    expect(report.content).toContain("&lt;script&gt;");
  });
});
