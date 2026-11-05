// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §2.3 — the report generator: Markdown (bug-bounty paste) and
// self-contained HTML (client-ready). Both formats are produced from the
// SAME gated pipeline:
//
//   1. Scope gate — every finding's target is re-checked against the
//      engagement (checkTarget, and checkUrl for path-bearing targets). One
//      out-of-scope finding aborts generation: OutOfScopeFindingError, no
//      file written. A report can never claim to have tested out-of-scope
//      assets — this is the last line of defense.
//   2. Evidence gate — every evidence artifact is read from the engagement
//      workspace and its sha256 re-verified (hard rule #5).
//   3. Render — the sections from §2.3, the scope statement auto-populated
//      from the engagement (id, client, window, targets, exclusions,
//      techniques — hard rule #6), findings ordered by severity band then
//      CVSS descending.
//
// The HTML is self-contained: one inline <style> block, no external asset
// fetches of any kind, and every finding-controlled string is escaped.

import { writeFile } from "node:fs/promises";
import type { Engagement } from "@nyx/protocol";
import { checkTarget } from "@nyx/scope";
import type { Finding } from "../findings/schema.js";
import { severityRank } from "../findings/schema.js";
import { orderFindingsForReport } from "../findings/store.js";
import { checkUrl } from "../engagement/matcher.js";
import { verifyEvidence, type VerifiedEvidence } from "./evidence.js";

export class OutOfScopeFindingError extends Error {
  constructor(
    readonly finding_id: string,
    readonly target: string,
    readonly reason: string,
  ) {
    super(
      `finding ${finding_id} targets ${target}, which is outside engagement scope: ` +
        `${reason} — the report is not generated`,
    );
    this.name = "OutOfScopeFindingError";
  }
}

export interface ReportInput {
  engagement: Engagement;
  findings: readonly Finding[];
  /** The engagement workspace root holding evidence artifacts. */
  evidence_root: string;
  format: "markdown" | "html";
  /** Where to write the report. The file is written only after both gates pass. */
  out_path?: string;
  now?: () => number;
  /** Free-form methodology notes for the Methodology section. */
  methodology_notes?: string;
}

export interface RenderedReport {
  content: string;
  format: "markdown" | "html";
  /** Present when out_path was given (written after the gates). */
  written_to?: string;
  findings_included: number;
  generated_at: number;
}

/** Hostname-shaped hosts only — the URL fallback never re-parses hostile
 * strings like "example.com\\@evil.com" into an in-scope authority (R2-6). */
const HOSTNAME_SHAPE = /^[A-Za-z0-9.-]+$/;

/** Split an inline "host:port" out of a finding's host string (R2-4: a port
 * embedded in the host must face the port policy, not ride it). */
function splitHostPort(host: string): { host: string; port?: number } {
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close > 0 && host.charAt(close + 1) === ":") {
      const suffix = host.slice(close + 2);
      if (/^\d+$/.test(suffix)) return { host: host.slice(0, close + 1), port: Number(suffix) };
    }
    return { host };
  }
  const colon = host.indexOf(":");
  if (colon !== -1 && host.indexOf(":", colon + 1) === -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return { host: host.slice(0, colon), port: Number(host.slice(colon + 1)) };
  }
  return { host };
}

/**
 * The scope gate: one finding outside the engagement aborts the report.
 * Each finding is evaluated at ITS OWN discovery time, which must lie inside
 * the engagement window — the report is written after the window closes in
 * the normal workflow, and the targets were in scope when the finding was
 * recorded (R1-8). A finding discovered outside the window is refused.
 */
export function assertFindingsInScope(
  engagement: Engagement,
  findings: readonly Finding[],
  _now: number,
): void {
  for (const f of findings) {
    if (
      engagement.starts_at !== undefined &&
      (f.discovered_at < engagement.starts_at || f.discovered_at >= engagement.expires_at)
    ) {
      throw new OutOfScopeFindingError(
        f.id,
        f.target.host,
        `discovered ${new Date(f.discovered_at).toISOString()} — outside the engagement window ` +
          `${new Date(engagement.starts_at).toISOString()} → ${new Date(engagement.expires_at).toISOString()}`,
      );
    }
    const split = splitHostPort(f.target.host);
    const host = split.host;
    const port = f.target.port ?? split.port;
    const path = f.target.path;
    const hostQuery = port !== undefined ? { host, port } : { host };
    const verdict = checkTarget(engagement, hostQuery, f.discovered_at);
    if (verdict.allowed) continue;
    // Host-level authorization failed. A path-bearing target may still be
    // authorized by a URL target entry — check the concrete URL forms.
    if (path !== undefined && HOSTNAME_SHAPE.test(host)) {
      const portSuffix = port !== undefined ? `:${port}` : "";
      for (const scheme of ["https", "http"] as const) {
        const url = `${scheme}://${host}${portSuffix}${path}`;
        if (checkUrl(engagement, url, f.discovered_at).allowed) break;
        if (scheme === "http") {
          throw new OutOfScopeFindingError(f.id, `${host}${portSuffix}${path}`, verdict.reason);
        }
      }
      continue;
    }
    throw new OutOfScopeFindingError(f.id, `${host}${port !== undefined ? `:${port}` : ""}`, verdict.reason);
  }
}

export async function generateReport(input: ReportInput): Promise<RenderedReport> {
  const now = (input.now ?? Date.now)();

  // Gate 1: scope. Gate 2: evidence (every finding must HAVE hash-verified
  // evidence — hard rule #5; an empty evidence list is a vacuous pass and is
  // refused). Both BEFORE any rendering or writing.
  assertFindingsInScope(input.engagement, input.findings, now);
  const evidenceByFinding = new Map<string, VerifiedEvidence[]>();
  for (const [index, f] of input.findings.entries()) {
    if (f.evidence.length === 0) {
      throw Object.assign(
        new Error(
          `finding ${f.id} ("${f.title}") has no evidence — a finding without a ` +
            "hash-verified artifact is not a finding (hard rule #5)",
        ),
        { name: "OutOfScopeFindingError", code: "missing_evidence" },
      );
    }
    // Keyed with the index: duplicate ids cannot mis-attribute evidence (R2-7).
    evidenceByFinding.set(`${f.id}#${index}`, await verifyEvidence(input.evidence_root, f.evidence));
  }

  const ordered = orderFindingsForReport(input.findings);
  const content =
    input.format === "markdown"
      ? renderMarkdown(input, ordered, evidenceByFinding, now)
      : renderHtml(input, ordered, evidenceByFinding, now);

  const report: RenderedReport = {
    content,
    format: input.format,
    findings_included: ordered.length,
    generated_at: now,
  };
  if (input.out_path !== undefined) {
    await writeFile(input.out_path, content, "utf8");
    report.written_to = input.out_path;
  }
  return report;
}

// ── shared bits ─────────────────────────────────────────────────────────────

function iso(ms: number | undefined): string {
  return ms === undefined ? "(unknown)" : new Date(ms).toISOString();
}

function severityCounts(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

function toolsUsed(findings: readonly Finding[]): string[] {
  return [...new Set(findings.map((f) => f.discovered_by))].sort();
}

function cvssLine(f: Finding): string {
  const parts: string[] = [];
  if (f.cvss_4_0 !== undefined) parts.push(`CVSS 4.0 ${f.cvss_4_0.toFixed(1)}`);
  if (f.cvss_3_1 !== undefined) parts.push(`CVSS 3.1 ${f.cvss_3_1.toFixed(1)}`);
  return parts.length > 0 ? ` (${parts.join(" · ")})` : "";
}

// ── markdown ────────────────────────────────────────────────────────────────

function renderMarkdown(
  input: ReportInput,
  ordered: readonly Finding[],
  evidence: ReadonlyMap<string, VerifiedEvidence[]>,
  now: number,
): string {
  const e = input.engagement;
  const counts = severityCounts(ordered);
  const lines: string[] = [];

  lines.push(`# Security Assessment Report — ${e.client ?? e.id}`);
  lines.push("");
  lines.push(
    `Engagement \`${e.id}\` · window ${iso(e.starts_at)} → ${iso(e.expires_at)} · generated ${iso(now)}`,
  );
  lines.push("");

  lines.push("## Executive Summary");
  lines.push("");
  lines.push(
    `${ordered.length} finding${ordered.length === 1 ? "" : "s"} within the authorized scope: ` +
      `${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.medium ?? 0} medium, ` +
      `${counts.low ?? 0} low, ${counts.info ?? 0} informational.`,
  );
  if ((counts.critical ?? 0) + (counts.high ?? 0) > 0) {
    lines.push("");
    lines.push(
      "**Priority:** the critical and high findings below should be remediated first; " +
        "each carries reproduction steps and verified evidence.",
    );
  }
  lines.push("");

  lines.push("## Scope Statement");
  lines.push("");
  lines.push("This assessment covered exactly the assets authorized by the engagement:");
  lines.push("");
  lines.push(`- **Engagement id:** \`${e.id}\``);
  lines.push(`- **Client:** ${e.client ?? "(not recorded)"}`);
  lines.push(`- **Authorization window:** ${iso(e.starts_at)} → ${iso(e.expires_at)}`);
  lines.push(`- **Authorized by:** ${e.authorized_by ?? "(not recorded)"}`);
  lines.push(`- **Emergency contact:** ${e.emergency_contact ?? "(not recorded)"}`);
  lines.push(`- **Domains:** ${e.targets.domains.join(", ") || "(none)"}`);
  lines.push(`- **CIDR ranges:** ${e.targets.cidrs.join(", ") || "(none)"}`);
  lines.push(`- **URL targets:** ${(e.targets.urls ?? []).join(", ") || "(none)"}`);
  const ex = e.targets.exclude;
  lines.push(
    `- **Exclusions:** ` +
      `${[...(ex?.domains ?? []), ...(ex?.cidrs ?? [])].join(", ") || "(none)"}`,
  );
  lines.push(
    `- **Authorized techniques:** ${(e.techniques ?? []).join(", ") || "(none recorded)"}`,
  );
  lines.push("");
  lines.push(
    "No asset outside this set was tested. Report generation structurally refuses " +
      "out-of-scope findings.",
  );
  lines.push("");

  lines.push("## Methodology");
  lines.push("");
  lines.push(
    `Authorized techniques: ${(e.techniques ?? []).join(", ") || "(none recorded)"}. ` +
      `Tools used: ${toolsUsed(ordered).join(", ") || "(none)"}.`,
  );
  if (input.methodology_notes !== undefined && input.methodology_notes.length > 0) {
    lines.push("");
    lines.push(input.methodology_notes);
  }
  lines.push("");

  lines.push("## Findings");
  lines.push("");
  if (ordered.length === 0) {
    lines.push("_No findings were recorded for this engagement._");
  }
  for (const f of ordered) {
    lines.push(`### [${f.severity.toUpperCase()}] ${f.title}${cvssLine(f)}`);
    lines.push("");
    const t = f.target;
    lines.push(
      `- **Target:** \`${t.host}${t.port !== undefined ? `:${t.port}` : ""}${t.path ?? ""}\``,
    );
    lines.push(`- **Status:** ${f.status}`);
    if (f.cve !== undefined && f.cve.length > 0) lines.push(`- **CVE:** ${f.cve.join(", ")}`);
    if (f.cwe !== undefined && f.cwe.length > 0) lines.push(`- **CWE:** ${f.cwe.join(", ")}`);
    lines.push(`- **Discovered by:** ${f.discovered_by}`);
    lines.push("");
    lines.push(f.description);
    lines.push("");
    lines.push("**Reproduction steps:**");
    lines.push("");
    lines.push(f.reproduction);
    lines.push("");
    lines.push("**Remediation:**");
    lines.push("");
    lines.push(f.remediation);
    lines.push("");
    if (f.notes.length > 0) {
      lines.push(`**Notes:** ${f.notes}`);
      lines.push("");
    }
  }

  lines.push("## Evidence");
  lines.push("");
  lines.push("Every artifact below was hash-verified (sha256) at report time:");
  lines.push("");
  for (const [index, f] of ordered.entries()) {
    const arts = evidence.get(`${f.id}#${index}`) ?? [];
    if (arts.length === 0) continue;
    lines.push(`- **${f.title}**`);
    for (const a of arts) {
      lines.push(`  - \`${a.path}\` — sha256 \`${a.hash}\` — ${a.mime} — ${a.bytes} bytes`);
    }
  }
  lines.push("");

  lines.push("## Remediation Summary");
  lines.push("");
  for (const f of ordered) {
    lines.push(`- **[${f.severity.toUpperCase()}]** ${f.title}: ${f.remediation}`);
  }
  lines.push("");

  lines.push("## Appendix — raw output index");
  lines.push("");
  lines.push(
    "Raw tool output lives in the engagement workspace as the evidence artifacts " +
      "listed above; the recorded sha256 pins the exact bytes.",
  );
  lines.push("");
  return lines.join("\n");
}

// ── html ────────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderHtml(
  input: ReportInput,
  ordered: readonly Finding[],
  evidence: ReadonlyMap<string, VerifiedEvidence[]>,
  now: number,
): string {
  const e = input.engagement;
  const counts = severityCounts(ordered);
  const findingsHtml = ordered
    .map((f, index) => {
      const t = f.target;
      const arts = (evidence.get(`${f.id}#${index}`) ?? [])
        .map(
          (a) =>
            `<li><code>${esc(a.path)}</code> — sha256 <code>${esc(a.hash)}</code> — ${esc(a.mime)} — ${a.bytes} bytes</li>`,
        )
        .join("");
      return `
<section class="finding ${esc(f.severity)}">
  <h3><span class="sev">${esc(f.severity.toUpperCase())}</span> ${esc(f.title)}${esc(cvssLine(f))}</h3>
  <dl class="meta">
    <dt>Target</dt><dd><code>${esc(t.host)}${t.port !== undefined ? `:${t.port}` : ""}${esc(t.path ?? "")}</code></dd>
    <dt>Status</dt><dd>${esc(f.status)}</dd>
    ${f.cve !== undefined && f.cve.length > 0 ? `<dt>CVE</dt><dd>${esc(f.cve.join(", "))}</dd>` : ""}
    ${f.cwe !== undefined && f.cwe.length > 0 ? `<dt>CWE</dt><dd>${esc(f.cwe.join(", "))}</dd>` : ""}
    <dt>Discovered by</dt><dd>${esc(f.discovered_by)}</dd>
  </dl>
  <p>${esc(f.description)}</p>
  <h4>Reproduction steps</h4>
  <pre>${esc(f.reproduction)}</pre>
  <h4>Remediation</h4>
  <p>${esc(f.remediation)}</p>
  ${f.notes.length > 0 ? `<p class="notes"><strong>Notes:</strong> ${esc(f.notes)}</p>` : ""}
  ${arts.length > 0 ? `<h4>Evidence</h4><ul class="evidence">${arts}</ul>` : ""}
</section>`;
    })
    .join("\n");

  const evidenceRows = ordered
    .flatMap((f, index) => (evidence.get(`${f.id}#${index}`) ?? []).map((a) => ({ f, a })))
    .map(
      ({ f, a }) =>
        `<tr><td>${esc(f.title)}</td><td><code>${esc(a.path)}</code></td><td><code>${esc(a.hash)}</code></td><td>${a.bytes}</td></tr>`,
    )
    .join("\n");

  const remediationRows = ordered
    .map(
      (f) =>
        `<tr><td><span class="sev ${esc(f.severity)}">${esc(f.severity.toUpperCase())}</span></td><td>${esc(f.title)}</td><td>${esc(f.remediation)}</td></tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Assessment Report — ${esc(e.client ?? e.id)}</title>
<style>
  :root { color-scheme: light; }
  body { font-family: Georgia, "Times New Roman", serif; margin: 0 auto; max-width: 60rem; padding: 2rem 1.5rem; line-height: 1.55; color: #1a1a1a; }
  h1, h2, h3, h4 { font-family: "Helvetica Neue", Arial, sans-serif; line-height: 1.25; }
  h1 { border-bottom: 3px solid #1a1a1a; padding-bottom: .4rem; }
  h2 { border-bottom: 1px solid #ccc; padding-bottom: .25rem; margin-top: 2.2rem; }
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; background: #f4f4f4; padding: .08em .3em; border-radius: 3px; }
  pre { background: #f7f7f7; border: 1px solid #ddd; border-radius: 4px; padding: .8rem 1rem; overflow-x: auto; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
  th, td { border: 1px solid #ccc; padding: .45rem .6rem; text-align: left; vertical-align: top; }
  th { background: #f0f0f0; font-family: "Helvetica Neue", Arial, sans-serif; }
  .finding { border: 1px solid #ddd; border-left: 5px solid #999; border-radius: 4px; padding: .2rem 1.2rem; margin: 1.4rem 0; }
  .finding.critical { border-left-color: #b3001b; }
  .finding.high { border-left-color: #e8590c; }
  .finding.medium { border-left-color: #f5a623; }
  .finding.low { border-left-color: #4c6ef5; }
  .finding.info { border-left-color: #868e96; }
  .sev { display: inline-block; font-family: "Helvetica Neue", Arial, sans-serif; font-weight: 700; font-size: .8em; padding: .1em .5em; border-radius: 3px; color: #fff; background: #868e96; }
  .sev.critical { background: #b3001b; } .sev.high { background: #e8590c; } .sev.medium { background: #f5a623; } .sev.low { background: #4c6ef5; }
  dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .15rem 1rem; }
  dl.meta dt { font-weight: 700; font-family: "Helvetica Neue", Arial, sans-serif; font-size: .9em; }
  dl.meta dd { margin: 0; }
  ul.evidence { padding-left: 1.2rem; }
  .window { color: #555; font-size: .95em; }
</style>
</head>
<body>
<h1>Security Assessment Report — ${esc(e.client ?? e.id)}</h1>
<p class="window">Engagement <code>${esc(e.id)}</code> · window ${esc(iso(e.starts_at))} → ${esc(iso(e.expires_at))} · generated ${esc(iso(now))}</p>

<h2>Executive Summary</h2>
<p>${ordered.length} finding${ordered.length === 1 ? "" : "s"} within the authorized scope:
<strong>${counts.critical} critical</strong>, <strong>${counts.high} high</strong>, ${counts.medium} medium, ${counts.low} low, ${counts.info} informational.</p>

<h2>Scope Statement</h2>
<p>This assessment covered exactly the assets authorized by the engagement. No asset outside this set was tested; report generation structurally refuses out-of-scope findings.</p>
<table>
  <tr><th>Field</th><th>Value</th></tr>
  <tr><td>Engagement id</td><td><code>${esc(e.id)}</code></td></tr>
  <tr><td>Client</td><td>${esc(e.client ?? "(not recorded)")}</td></tr>
  <tr><td>Authorization window</td><td>${esc(iso(e.starts_at))} → ${esc(iso(e.expires_at))}</td></tr>
  <tr><td>Authorized by</td><td>${esc(e.authorized_by ?? "(not recorded)")}</td></tr>
  <tr><td>Emergency contact</td><td>${esc(e.emergency_contact ?? "(not recorded)")}</td></tr>
  <tr><td>Domains</td><td>${esc(e.targets.domains.join(", ") || "(none)")}</td></tr>
  <tr><td>CIDR ranges</td><td>${esc(e.targets.cidrs.join(", ") || "(none)")}</td></tr>
  <tr><td>URL targets</td><td>${esc((e.targets.urls ?? []).join(", ") || "(none)")}</td></tr>
  <tr><td>Exclusions</td><td>${esc([...(e.targets.exclude?.domains ?? []), ...(e.targets.exclude?.cidrs ?? [])].join(", ") || "(none)")}</td></tr>
  <tr><td>Authorized techniques</td><td>${esc((e.techniques ?? []).join(", ") || "(none recorded)")}</td></tr>
</table>

<h2>Methodology</h2>
<p>Authorized techniques: ${esc((e.techniques ?? []).join(", ") || "(none recorded)")}. Tools used: ${esc(toolsUsed(ordered).join(", ") || "(none)")}.</p>
${input.methodology_notes !== undefined && input.methodology_notes.length > 0 ? `<p>${esc(input.methodology_notes)}</p>` : ""}

<h2>Findings</h2>
${ordered.length === 0 ? "<p><em>No findings were recorded for this engagement.</em></p>" : findingsHtml}

<h2>Evidence</h2>
<p>Every artifact below was hash-verified (sha256) at report time.</p>
<table>
  <tr><th>Finding</th><th>Artifact</th><th>sha256</th><th>Bytes</th></tr>
  ${evidenceRows}
</table>

<h2>Remediation Summary</h2>
<table>
  <tr><th>Severity</th><th>Finding</th><th>Remediation</th></tr>
  ${remediationRows}
</table>

<h2>Appendix — raw output index</h2>
<p>Raw tool output lives in the engagement workspace as the evidence artifacts listed above; the recorded sha256 pins the exact bytes.</p>
</body>
</html>
`;
}

/** Order-only helper re-export for callers composing their own views. */
export { severityRank };
