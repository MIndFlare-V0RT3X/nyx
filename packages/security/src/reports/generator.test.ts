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
// The engagement window's END must be anchored to the REAL clock: the
// generator's scope gate runs on `input.now ?? Date.now()` and these tests
// never inject `now`, so an absolute calendar expiry is a time bomb (the
// old 2026-12-01 fixture would have failed every test after that instant).
// Evaluated ONCE at module scope so the fixture and the rendered-content
// assertion below observe the same value.
const WINDOW_EXPIRES = Date.now() + 26 * 86_400_000;

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
    expires_at: WINDOW_EXPIRES,
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
  await writeFile(
    path.join(root, "xss-poc.txt"),
    "GET /portal/login?q=<script>alert(1)</script>",
    "utf8",
  );
  const hash = createHash("sha256")
    .update(readFileSync(path.join(root, "xss-poc.txt")))
    .digest("hex");
  return {
    root,
    artifact: [{ path: "xss-poc.txt", hash, mime: "text/plain" }],
  };
}

/** A findings fixture where every finding carries REAL hash-verified
 * evidence (hard rule #5 — the report gate refuses empty evidence). */
async function evidencedFindings(
  root: string,
  overrides: Array<Partial<Finding>>,
): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const [i, o] of overrides.entries()) {
    const name = `ev-${i}-${Math.random().toString(36).slice(2, 8)}.txt`;
    await writeFile(path.join(root, name), `evidence for ${o.id ?? i}\n`, "utf8");
    const hash = createHash("sha256")
      .update(readFileSync(path.join(root, name)))
      .digest("hex");
    out.push(finding({ ...o, evidence: [{ path: name, hash, mime: "text/plain" }] }));
  }
  return out;
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
      generateReport({
        engagement: engagement(),
        findings,
        evidence_root: root,
        format: "markdown",
        out_path: out,
        now: () => NOW,
      }),
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
    const findings = await evidencedFindings(root, [
      { id: "in", target: { host: "app.example.com", path: "/portal/login" } },
    ]);
    const ok = await generateReport({
      engagement: {
        ...engagement(),
        targets: { domains: [], cidrs: [], urls: ["https://app.example.com/portal/*"] },
      },
      findings,
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    });
    expect(ok.findings_included).toBe(1);
    await expect(
      generateReport({
        engagement: {
          ...engagement(),
          targets: { domains: [], cidrs: [], urls: ["https://app.example.com/portal/*"] },
        },
        findings: await evidencedFindings(root, [
          { id: "out", target: { host: "app.example.com", path: "/admin/login" } },
        ]),
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
        findings: [
          finding({ evidence: [{ path: "gone.txt", hash: "0".repeat(64), mime: "text/plain" }] }),
        ],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ code: "missing" });
  });

  it("a path escaping the workspace aborts the report", async () => {
    const root = await tmpDir("nyx-report-esc-");
    await expect(
      verifyEvidence(root, [
        { path: "../../etc/passwd", hash: "0".repeat(64), mime: "text/plain" },
      ]),
    ).rejects.toMatchObject({ code: "escape" });
  });
});

describe("report-gate regressions (the two-reviewer fan-out)", () => {
  it("R1-8: a report generates AFTER the window closed — findings discovered in-window are in scope", async () => {
    const root = await tmpDir("nyx-report-exp-");
    const findings = await evidencedFindings(root, [{ discovered_at: Date.UTC(2026, 10, 3) }]);
    const expired = { ...engagement(), expires_at: NOW - 86_400_000 };
    // discovered_at (Nov 3) is inside the window; NOW (Nov 5) is after it.
    const report = await generateReport({
      engagement: expired,
      findings,
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    });
    expect(report.findings_included).toBe(1);
  });

  it("R1-8 (the other edge): a finding discovered BEFORE the window opened is refused", async () => {
    const root = await tmpDir("nyx-report-early-");
    const findings = await evidencedFindings(root, [{ discovered_at: Date.UTC(2026, 9, 1) }]);
    await expect(
      generateReport({
        engagement: engagement(),
        findings,
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ name: "OutOfScopeFindingError" });
  });

  it("R2-3: a finding with NO evidence is refused — hard rule #5", async () => {
    const root = await tmpDir("nyx-report-noev-");
    await expect(
      generateReport({
        engagement: engagement(),
        findings: [finding({ evidence: [] })],
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toThrow(/no evidence/);
  });

  it("R2-4: a port embedded in the host string faces the port policy", async () => {
    const root = await tmpDir("nyx-report-port-");
    const eng = { ...engagement(), targets: { ...engagement().targets, ports: { allow: [443] } } };
    const findings = await evidencedFindings(root, [
      { id: "hostport", target: { host: "example.com:8080" } },
    ]);
    await expect(
      generateReport({
        engagement: eng,
        findings,
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ name: "OutOfScopeFindingError" });
  });

  it("R2-6: a hostile host shape cannot ride the URL fallback", async () => {
    const root = await tmpDir("nyx-report-shape-");
    const findings = await evidencedFindings(root, [
      { id: "weird", target: { host: "example.com\\@evil.com", path: "/portal/login" } },
    ]);
    await expect(
      generateReport({
        engagement: {
          ...engagement(),
          targets: { domains: [], cidrs: [], urls: ["https://example.com/portal/*"] },
        },
        findings,
        evidence_root: root,
        format: "markdown",
        now: () => NOW,
      }),
    ).rejects.toMatchObject({ name: "OutOfScopeFindingError" });
  });

  it("R2-7: duplicate finding ids render their OWN evidence, not the last one's", async () => {
    const root = await tmpDir("nyx-report-dup-");
    const findings = await evidencedFindings(root, [{ id: "same" }, { id: "same" }]);
    const report = await generateReport({
      engagement: engagement(),
      findings,
      evidence_root: root,
      format: "markdown",
      now: () => NOW,
    });
    // Both artifacts listed under the Evidence section.
    expect(report.content).toContain("ev-0-");
    expect(report.content).toContain("ev-1-");
  });

  it("R2-2: a symlink inside the workspace pointing outside is refused", async () => {
    const { root, artifact } = await evidenceDir();
    const outside = await tmpDir("nyx-report-outside-");
    await writeFile(path.join(outside, "secret.txt"), "outside material", "utf8");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    await expect(
      verifyEvidence(root, [{ path: "link.txt", hash: artifact[0]!.hash, mime: "text/plain" }]),
    ).rejects.toMatchObject({ code: "escape" });
  });
});

describe("generateReport — markdown (§2.4)", () => {
  it("renders with correct severity ordering and the exact engagement id + window", async () => {
    const root = await tmpDir("nyx-report-md-");
    const findings = await evidencedFindings(root, [
      { id: "low", severity: "low", title: "Low finding" },
      { id: "crit", severity: "critical", title: "Critical finding", cvss_4_0: 9.4 },
      { id: "high", severity: "high", title: "High finding", cvss_3_1: 8.3 },
      {
        id: "crit2",
        severity: "critical",
        title: "Older critical",
        cvss_4_0: 9.0,
        discovered_at: NOW - 7_200_000,
      },
    ]);
    const report = await generateReport({
      engagement: engagement(),
      findings,
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
    expect(c).toContain(new Date(WINDOW_EXPIRES).toISOString());
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
    const findings = await evidencedFindings(root, [{}]);
    const report = await generateReport({
      engagement: engagement(),
      findings,
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
    const findings = await evidencedFindings(root, [
      {
        title: '</h3><script>alert("report")</script>',
        description: "<img src=x onerror=alert(1)>",
        notes: `"><svg onload=alert(2)>`,
      },
    ]);
    const report = await generateReport({
      engagement: engagement(),
      findings,
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
