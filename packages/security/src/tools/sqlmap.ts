// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.2 §3.2 — sqlmap. Two tools, one binary, one console format:
//
//   security.sqlmap-scan   (vulnerability_scanning): detection only — the
//                          benign posture. Injection points become FINDINGS
//                          (evidence = the captured console output).
//   security.sqlmap-exploit (exploitation): data extraction (--dbs/--tables/
//                          --dump). Structurally absent unless the
//                          engagement declares `exploitation`.
//
// The console format parsed here is the REAL sqlmap output — the fixtures in
// fixtures/sqlmap-*.txt were captured from sqlmap 1.10.11 (pip) against a
// live vulnerable endpoint; the live-binary test (sqlmap.integration.test.ts)
// runs the actual binary when it is on PATH and skips otherwise.

import { z } from "zod";
import { createHash } from "node:crypto";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { egressProxyUrl, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export const SQLMAP_SCAN_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "sqlmap",
  unit: "requests",
};

export const SQLMAP_EXPLOIT_META: SecurityToolMeta = {
  technique: "exploitation",
  rate_class: "sqlmap",
  unit: "requests",
};

const urlSchema = z
  .string()
  .min(10)
  .max(2048)
  .regex(/^https?:\/\/[^\s]+$/, "absolute http(s) URL without userinfo");

/** The console sections the parser keys on (real sqlmap format). */
const INJECTION_HEADER =
  "sqlmap identified the following injection point(s) with a total of";
const NOT_INJECTABLE = "all tested parameters do not appear to be injectable";
const BACKEND_DBMS = "back-end DBMS:";

export interface SqlmapInjectionPoint {
  parameter: string;
  method: string;
  types: Array<{ type: string; title: string; payload: string }>;
}

export interface SqlmapScanResult {
  injectable: boolean;
  dbms: string | null;
  injection_points: SqlmapInjectionPoint[];
  total_requests: number | null;
}

/**
 * Parse sqlmap's console output (real format; see fixtures/). A clean
 * "not injectable" run is a RESULT (injectable: false), never an error.
 */
export function parseSqlmapScan(stdout: string): SqlmapScanResult {
  const lines = stdout.split("\n");
  const result: SqlmapScanResult = {
    injectable: false,
    dbms: null,
    injection_points: [],
    total_requests: null,
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith(BACKEND_DBMS)) {
      result.dbms = trimmed.slice(BACKEND_DBMS.length).trim();
    }
    if (line.includes(NOT_INJECTABLE)) {
      // [CRITICAL] all tested parameters do not appear to be injectable...
      result.injectable = false;
    }
    if (line.includes(INJECTION_HEADER)) {
      result.injectable = true;
      const m = /with a total of (\d+) HTTP\(s\) requests/.exec(line);
      if (m !== null) result.total_requests = Number(m[1]);
    }
  }

  // The injection blocks: a `---` fence, `Parameter: <p> (<METHOD>)`, then
  // indented `Type:` / `Title:` / `Payload:` triples (one per technique).
  let current: SqlmapInjectionPoint | null = null;
  let pendingType: string | null = null;
  let pendingTitle: string | null = null;
  const flushPoint = () => {
    if (current !== null && current.types.length > 0) {
      result.injection_points.push(current);
    }
    current = null;
  };
  for (const line of lines) {
    if (line.trim() === "---") {
      flushPoint();
      continue;
    }
    const paramMatch = /^Parameter: (.+) \((\w+)\)$/.exec(line.trim());
    if (paramMatch !== null) {
      flushPoint();
      current = {
        parameter: paramMatch[1] ?? "",
        method: paramMatch[2] ?? "GET",
        types: [],
      };
      continue;
    }
    if (current === null) continue;
    const t = line.trim();
    const typeMatch = /^Type: (.+)$/.exec(t);
    if (typeMatch !== null) {
      pendingType = typeMatch[1] ?? "";
      continue;
    }
    const titleMatch = /^Title: (.+)$/.exec(t);
    if (titleMatch !== null) {
      pendingTitle = titleMatch[1] ?? "";
      continue;
    }
    const payloadMatch = /^Payload: (.+)$/.exec(t);
    if (payloadMatch !== null && pendingType !== null && pendingTitle !== null) {
      current.types.push({
        type: pendingType,
        title: pendingTitle,
        payload: payloadMatch[1] ?? "",
      });
      pendingType = null;
      pendingTitle = null;
    }
  }
  flushPoint();
  return result;
}

/** sqlmap's common argv: batch mode, fresh session, no interactive prompts. */
function sqlmapBaseArgs(url: string, ctx: ToolContext): string[] {
  const args = [
    "--batch",
    "--flush-session",
    "-u",
    url,
    // Session/output state stays inside the workspace (sandbox) or the
    // harness cwd (host mode) — never an absolute path the model controls.
    "--output-dir",
    ".sqlmap",
  ];
  const proxy = egressProxyUrl(ctx, "sqlmap");
  if (proxy !== undefined) args.push("--proxy", proxy);
  return args;
}

// ---------------------------------------------------------------------------
// security.sqlmap-scan — detection (benign)
// ---------------------------------------------------------------------------

export const sqlmapScanInput = z
  .object({
    url: urlSchema,
    /** Detection depth 1–5 (sqlmap --level). Default 1. */
    level: z.number().int().min(1).max(5).optional(),
    /** Test risk 1–3 (sqlmap --risk). Default 1 — never 3 by default. */
    risk: z.number().int().min(1).max(3).optional(),
  })
  .strict();

const SCAN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) target URL (must be in engagement scope)." },
    level: { type: "integer", minimum: 1, maximum: 5, description: "sqlmap --level (detection depth). Default 1." },
    risk: { type: "integer", minimum: 1, maximum: 3, description: "sqlmap --risk. Default 1." },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

export function sqlmapScanDefinition(): ToolDefinition {
  return {
    name: "security.sqlmap-scan",
    description:
      "Detect SQL injection on an in-scope URL with sqlmap (benign detection only: --batch, no data extraction). Detected injection points are recorded as findings with the console output as hash-verified evidence. Data extraction is a separate tool (security.sqlmap-exploit) that requires the `exploitation` technique.",
    input_schema: SCAN_INPUT_SCHEMA,
    risk: "R2",
    capabilities: ["net.egress"],
    handler: "builtin:security.sqlmap-scan",
    timeout_ms: 900_000,
  };
}

export function sqlmapScanHandler(deps: SecurityToolDeps & {
  store: import("../findings/store.js").FindingStore;
}): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = sqlmapScanInput.parse(call.input);
      const parsed = parseActionUrl(input.url);
      if (parsed === null) {
        throw Object.assign(
          new Error("url must be an absolute http(s) URL without userinfo"),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      return runSecurityTool({
        tool: "security.sqlmap-scan",
        binary: "sqlmap",
        meta: SQLMAP_SCAN_META,
        ctx,
        deps,
        targets: [parsed],
        buildArgs: () => [
          ...sqlmapBaseArgs(parsed!.url, ctx),
          "--level",
          String(input.level ?? 1),
          "--risk",
          String(input.risk ?? 1),
        ],
        parse: async (stdout, c) => {
          const result = parseSqlmapScan(stdout);
          // Evidence: the raw console output, hash-verified like every
          // finding (no hash-verified artifact = not a finding).
          const evidencePath = `artifacts/sqlmap-${Date.now()}.txt`;
          await c.sandbox.writeFile(evidencePath, stdout);
          const hash = createHash("sha256").update(stdout).digest("hex");
          if (result.injectable && result.injection_points.length > 0) {
            const point = result.injection_points[0]!;
            const finding = await deps.store.createInSession(
              {
                session_id: c.session_id,
                engagement: c.engagement!,
              },
              {
                title: `SQL injection in parameter '${point.parameter}' (${point.method})`,
                description:
                  `sqlmap identified ${result.injection_points.length} injectable parameter(s) ` +
                  `at ${parsed!.url}. Techniques: ` +
                  result.injection_points
                    .flatMap((p) => p.types.map((t) => `${p.parameter}:${t.title}`))
                    .join("; ") +
                  (result.dbms !== null ? `. Back-end DBMS: ${result.dbms}.` : ""),
                severity: "high",
                target: { host: parsed!.host },
                evidence: [
                  { path: evidencePath, hash, mime: "text/plain" },
                ],
                reproduction:
                  `sqlmap --batch -u ${parsed!.url} (parameter '${point.parameter}', ` +
                  `payload: ${point.types[0]?.payload ?? "see evidence"})`,
                remediation:
                  "Use parameterized queries / prepared statements for every database access; " +
                  "validate and cast inputs server-side; see OWASP SQL Injection Prevention Cheat Sheet.",
                status: "open",
                discovered_by: "security.sqlmap-scan",
                notes: "",
              },
            );
            return { kind: "json", json: { ...result, finding_id: finding.id, evidence: { path: evidencePath, hash } } };
          }
          return { kind: "json", json: { ...result, evidence: { path: evidencePath, hash } } };
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// security.sqlmap-exploit — data extraction (requires `exploitation`)
// ---------------------------------------------------------------------------

export const sqlmapExploitInput = z
  .object({
    url: urlSchema,
    action: z.enum(["dbs", "tables", "dump"]),
    /** For action=tables: restrict to one database. */
    database: z.string().min(1).max(128).optional(),
    /** For action=dump: the table to dump (required for dump). */
    table: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine((i) => i.action !== "dump" || i.table !== undefined, {
    message: "action 'dump' requires 'table'",
    path: ["table"],
  });

const EXPLOIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string", description: "Absolute http(s) target URL (must be in engagement scope)." },
    action: { type: "string", enum: ["dbs", "tables", "dump"], description: "Enumeration or data extraction." },
    database: { type: "string", description: "For action=tables: restrict to one database." },
    table: { type: "string", description: "For action=dump: the table to extract." },
  },
  required: ["url", "action"],
  additionalProperties: false,
} as const;

export interface SqlmapDumpTable {
  database: string;
  table: string;
  entries: number | null;
  columns: string[] | null;
  rows: string[][];
  raw: string;
}

/**
 * Parse sqlmap's dumped-table block (real format; fixtures/sqlmap-exploit-
 * dump.txt): `Database: <current>` / `Table: users` / `[3 entries]` followed
 * by the ASCII box table.
 */
export function parseSqlmapDump(stdout: string): SqlmapDumpTable[] {
  const lines = stdout.split("\n");
  const tables: SqlmapDumpTable[] = [];
  let current: SqlmapDumpTable | null = null;
  let inBox = false;
  for (const line of lines) {
    const t = line.trim();
    const dbMatch = /^Database: (.+)$/.exec(t);
    if (dbMatch !== null) {
      if (current !== null) tables.push(current);
      current = { database: dbMatch[1] ?? "", table: "", entries: null, columns: null, rows: [], raw: "" };
      inBox = false;
      continue;
    }
    if (current === null) continue;
    const tableMatch = /^Table: (.+)$/.exec(t);
    if (tableMatch !== null) {
      current.table = tableMatch[1] ?? "";
      continue;
    }
    const entriesMatch = /^\[(\d+) entries?\]$/.exec(t);
    if (entriesMatch !== null) {
      current.entries = Number(entriesMatch[1]);
      continue;
    }
    if (t.startsWith("+") && t.endsWith("+")) {
      inBox = true; // box borders: +----+----+
      current.raw += line + "\n";
      continue;
    }
    if (inBox && t.startsWith("|") && t.endsWith("|")) {
      const cells = t
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());
      // The FIRST | row is the column header (id | name | secret) — the
      // real format always prints it; keep it out of the data rows.
      if (current.rows.length === 0 && current.columns === null) {
        current.columns = cells;
      } else {
        current.rows.push(cells);
      }
      current.raw += line + "\n";
      continue;
    }
    if (inBox && !t.startsWith("|")) inBox = false; // box ended
  }
  if (current !== null && current.table !== "") tables.push(current);
  return tables;
}

export function sqlmapExploitDefinition(): ToolDefinition {
  return {
    name: "security.sqlmap-exploit",
    description:
      "Extract data from a confirmed SQL injection with sqlmap (--dbs / --tables / --dump). Requires the engagement's `exploitation` technique — the tool is structurally absent without it. Evidence (the console output) is written to the workspace and hash-verified; extracted data is returned as structured rows and never auto-recorded as a finding (exploitation evidence is the operator's call).",
    input_schema: EXPLOIT_INPUT_SCHEMA,
    risk: "R3",
    capabilities: ["net.egress"],
    handler: "builtin:security.sqlmap-exploit",
    timeout_ms: 900_000,
  };
}

export function sqlmapExploitHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = sqlmapExploitInput.parse(call.input);
      const parsed = parseActionUrl(input.url);
      if (parsed === null) {
        throw Object.assign(
          new Error("url must be an absolute http(s) URL without userinfo"),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      return runSecurityTool({
        tool: "security.sqlmap-exploit",
        binary: "sqlmap",
        meta: SQLMAP_EXPLOIT_META,
        ctx,
        deps,
        targets: [parsed],
        buildArgs: () => {
          const args = [...sqlmapBaseArgs(parsed!.url, ctx)];
          if (input.action === "dbs") args.push("--dbs");
          if (input.action === "tables") {
            args.push("--tables");
            if (input.database !== undefined) args.push("-D", input.database);
          }
          if (input.action === "dump") {
            args.push("--dump", "-T", input.table!);
          }
          return args;
        },
        parse: async (stdout, c) => {
          const evidencePath = `artifacts/sqlmap-exploit-${Date.now()}.txt`;
          await c.sandbox.writeFile(evidencePath, stdout);
          const hash = createHash("sha256").update(stdout).digest("hex");
          const tables = parseSqlmapDump(stdout);
          return {
            kind: "json",
            json: {
              action: input.action,
              tables,
              evidence: { path: evidencePath, hash },
            },
          };
        },
      });
    },
  };
}
