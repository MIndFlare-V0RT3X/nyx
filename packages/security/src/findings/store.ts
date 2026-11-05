// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §2.2 — the findings store: raw SQL over nyx.db's `findings` table
// (schema 0004_findings), FTS5 search over title/description, and the
// structural session binding (a finding cannot land with an engagement id
// other than its session's — the ids are DERIVED from the binding, never
// taken from caller input).
//
// The table is created by the session store's migration runner (0004) when
// the shared handle opens; the store never issues DDL itself.

import type { Database } from "better-sqlite3";
import { canonicalJson } from "@nyx/protocol";
import { nanoid } from "nanoid";
import type {
  Finding,
  FindingEvidence,
  FindingSessionBinding,
  FindingSeverity,
  FindingStatus,
  FindingTarget,
} from "./schema.js";
import { severityRank } from "./schema.js";

export interface FindingStoreDeps {
  db: Database;
  now?: () => number;
}

export interface FindingListOptions {
  engagement_id?: string;
  severity?: FindingSeverity[];
  status?: FindingStatus;
  limit?: number;
}

interface FindingRow {
  id: string;
  engagement_id: string;
  session_id: string;
  title: string;
  description: string;
  severity: string;
  cvss_3_1: number | null;
  cvss_4_0: number | null;
  cwe_json: string | null;
  cve_json: string | null;
  target_json: string;
  evidence_json: string;
  reproduction: string;
  remediation: string;
  status: string;
  discovered_at: number;
  discovered_by: string;
  notes: string;
  updated_at: number;
}

export class FindingStoreError extends Error {
  constructor(
    readonly code:
      | "no_engagement"
      | "not_found"
      | "invalid"
      | "unknown_session"
      | "engagement_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "FindingStoreError";
  }
}

export class FindingStore {
  private readonly db: Database;
  private readonly now: () => number;

  constructor(deps: FindingStoreDeps) {
    this.db = deps.db;
    this.now = deps.now ?? Date.now;
  }

  /** Create a finding (the brief's §2.2 surface). */
  async create(finding: Omit<Finding, "id" | "discovered_at">): Promise<Finding> {
    // R2-5 (closed Phase 6.3): the admin surface VERIFIES the binding —
    // the session must exist and its bound engagement must match the
    // finding's engagement id. Caller-asserted pairs that do not correspond
    // to a real session are refused; the model-reachable path
    // (createInSession) derives the ids and is unchanged.
    const session = this.db
      .prepare("SELECT engagement_json FROM sessions WHERE id = ?")
      .get(finding.session_id) as { engagement_json: string | null } | undefined;
    if (session === undefined) {
      throw new FindingStoreError(
        "unknown_session",
        `session ${finding.session_id} does not exist — findings cannot be created for fabricated sessions`,
      );
    }
    if (session.engagement_json !== null) {
      const bound = JSON.parse(session.engagement_json) as { id?: string };
      if (bound.id !== finding.engagement_id) {
        throw new FindingStoreError(
          "engagement_mismatch",
          `session ${finding.session_id} is bound to engagement ${bound.id ?? "(unknown)"}, not ${finding.engagement_id}`,
        );
      }
    } else if (finding.engagement_id !== "") {
      throw new FindingStoreError(
        "engagement_mismatch",
        `session ${finding.session_id} has no engagement; a finding cannot claim engagement ${finding.engagement_id}`,
      );
    }
    const id = nanoid(16);
    const discovered_at = this.now();
    this.db
      .prepare(
        `INSERT INTO findings (id, engagement_id, session_id, title, description, severity,
            cvss_3_1, cvss_4_0, cwe_json, cve_json, target_json, evidence_json,
            reproduction, remediation, status, discovered_at, discovered_by, notes, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        finding.engagement_id,
        finding.session_id,
        finding.title,
        finding.description,
        finding.severity,
        finding.cvss_3_1 ?? null,
        finding.cvss_4_0 ?? null,
        finding.cwe === undefined ? null : canonicalJson(finding.cwe),
        finding.cve === undefined ? null : canonicalJson(finding.cve),
        canonicalJson(finding.target),
        canonicalJson(finding.evidence),
        finding.reproduction,
        finding.remediation,
        finding.status,
        discovered_at,
        finding.discovered_by,
        finding.notes ?? "",
        discovered_at,
      );
    return this.require(id);
  }

  /**
   * Create a finding bound to a session: engagement_id and session_id are
   * DERIVED from the binding, never taken from the input — a finding cannot
   * land with a foreign engagement id (§5 Reviewer 2's structural check).
   * Refuses when the session has no engagement.
   */
  async createInSession(
    binding: FindingSessionBinding,
    finding: Omit<Finding, "id" | "discovered_at" | "session_id" | "engagement_id">,
  ): Promise<Finding> {
    if (binding.engagement === null) {
      throw new FindingStoreError(
        "no_engagement",
        "findings require an engagement — the session has none loaded",
      );
    }
    return this.create({
      ...finding,
      engagement_id: binding.engagement.id,
      session_id: binding.session_id,
    });
  }

  async get(id: string): Promise<Finding | null> {
    const row = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as
      | FindingRow
      | undefined;
    return row === undefined ? null : rowToFinding(row);
  }

  async list(opts: FindingListOptions): Promise<Finding[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.engagement_id !== undefined) {
      where.push("engagement_id = ?");
      params.push(opts.engagement_id);
    }
    if (opts.severity !== undefined && opts.severity.length > 0) {
      where.push(`severity IN (${opts.severity.map(() => "?").join(",")})`);
      params.push(...opts.severity);
    }
    if (opts.status !== undefined) {
      where.push("status = ?");
      params.push(opts.status);
    }
    const limit = opts.limit ?? 500;
    const sql =
      `SELECT * FROM findings ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""} ` +
      `ORDER BY discovered_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as FindingRow[];
    return rows.map(rowToFinding);
  }

  async update(id: string, patch: Partial<Finding>): Promise<Finding> {
    const before = await this.get(id);
    if (before === null) throw new FindingStoreError("not_found", `finding ${id} not found`);
    const next: Finding = { ...before, ...patch, id, discovered_at: before.discovered_at };
    this.db
      .prepare(
        `UPDATE findings SET title = ?, description = ?, severity = ?, cvss_3_1 = ?, cvss_4_0 = ?,
            cwe_json = ?, cve_json = ?, target_json = ?, evidence_json = ?, reproduction = ?,
            remediation = ?, status = ?, notes = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.title,
        next.description,
        next.severity,
        next.cvss_3_1 ?? null,
        next.cvss_4_0 ?? null,
        next.cwe === undefined ? null : canonicalJson(next.cwe),
        next.cve === undefined ? null : canonicalJson(next.cve),
        canonicalJson(next.target),
        canonicalJson(next.evidence),
        next.reproduction,
        next.remediation,
        next.status,
        next.notes ?? "",
        this.now(),
        id,
      );
    return this.require(id);
  }

  /** FTS search over title/description. The query is sanitized to AND-joined
   * quoted tokens — never interpolated raw into MATCH syntax. */
  async search(query: string): Promise<Finding[]> {
    const tokens = query.match(/[a-zA-Z0-9]+/g) ?? [];
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t}"`).join(" AND ");
    const rows = this.db
      .prepare(
        `SELECT f.* FROM findings_fts ft JOIN findings f ON f.rowid = ft.rowid
          WHERE findings_fts MATCH ? ORDER BY rank LIMIT 200`,
      )
      .all(match) as FindingRow[];
    return rows.map(rowToFinding);
  }

  private require(id: string): Finding {
    const found = this.db.prepare("SELECT * FROM findings WHERE id = ?").get(id) as
      | FindingRow
      | undefined;
    if (found === undefined) {
      throw new FindingStoreError("not_found", `finding ${id} not found after write`);
    }
    return rowToFinding(found);
  }
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    engagement_id: row.engagement_id,
    session_id: row.session_id,
    title: row.title,
    description: row.description,
    severity: row.severity as FindingSeverity,
    ...(row.cvss_3_1 !== null ? { cvss_3_1: row.cvss_3_1 } : {}),
    ...(row.cvss_4_0 !== null ? { cvss_4_0: row.cvss_4_0 } : {}),
    ...(row.cwe_json !== null ? { cwe: JSON.parse(row.cwe_json) as string[] } : {}),
    ...(row.cve_json !== null ? { cve: JSON.parse(row.cve_json) as string[] } : {}),
    target: JSON.parse(row.target_json) as FindingTarget,
    evidence: JSON.parse(row.evidence_json) as FindingEvidence[],
    reproduction: row.reproduction,
    remediation: row.remediation,
    status: row.status as FindingStatus,
    discovered_at: row.discovered_at,
    discovered_by: row.discovered_by,
    notes: row.notes,
  };
}

/** Severity-ordered listing for reports (critical first, then CVSS-desc). */
export function orderFindingsForReport(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const score = (f: Finding): number => f.cvss_4_0 ?? f.cvss_3_1 ?? -1;
    return score(b) - score(a) || a.discovered_at - b.discovered_at;
  });
}
