// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §2.2 — the Finding type and severity helpers.

import type { Engagement } from "@nyx/protocol";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type FindingStatus = "open" | "confirmed" | "false_positive" | "duplicate";

/** One hash-verified evidence artifact (inside the engagement workspace). */
export interface FindingEvidence {
  path: string;
  hash: string;
  mime: string;
}

export interface FindingTarget {
  host: string;
  port?: number;
  path?: string;
}

export interface Finding {
  id: string;
  engagement_id: string;
  session_id: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  cvss_3_1?: number;
  cvss_4_0?: number;
  cwe?: string[];
  cve?: string[];
  target: FindingTarget;
  evidence: FindingEvidence[];
  /** Steps to reproduce — required, a finding without steps is not a finding. */
  reproduction: string;
  remediation: string;
  status: FindingStatus;
  discovered_at: number;
  /** Tool + skill id that produced the finding, e.g. "nuclei/security.nuclei". */
  discovered_by: string;
  notes: string;
}

/** Rank for severity ordering (critical first). */
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_RANK[severity] ?? 99;
}

/** Map a CVSS score (either version) to the finding severity band. */
export function severityFromScore(score: number): FindingSeverity {
  if (!(score >= 0 && score <= 10)) {
    throw new RangeError(`cvss score ${score} is outside 0–10`);
  }
  if (score === 0) return "info";
  if (score < 4) return "low";
  if (score < 7) return "medium";
  if (score < 9) return "high";
  return "critical";
}

/** The CVSS severity label (spec bands — same thresholds as finding bands). */
export function cvssSeverityLabel(score: number): "None" | "Low" | "Medium" | "High" | "Critical" {
  const band = severityFromScore(score);
  if (band === "info") return "None";
  return band.charAt(0).toUpperCase() + band.slice(1) as "Low" | "Medium" | "High" | "Critical";
}

/**
 * Compare two findings for report ordering: severity band first, then the
 * higher of the two CVSS scores (4.0 preferred when both exist), then the
 * earlier discovery (stable for equal keys).
 */
export function compareFindingsForReport(a: Finding, b: Finding): number {
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity;
  const score = (f: Finding): number =>
    f.cvss_4_0 ?? f.cvss_3_1 ?? (f.severity === "info" ? 0 : -1);
  const byScore = score(b) - score(a);
  if (byScore !== 0) return byScore;
  return a.discovered_at - b.discovered_at;
}

/** The session binding a finding is written under (structural provenance). */
export interface FindingSessionBinding {
  session_id: string;
  engagement: Engagement | null;
}
