// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.2 §3.2 — Metasploit console access. TWO tools, one binary:
//
//   security.msf-search — search modules / inspect a module's options. A
//       LOCAL console query (no target egress — capabilities: [], no scope
//       target), charset-guarded argv, msfconsole batch mode.
//   security.msf-run    — run ONE module against an authorized target
//       (RHOSTS scope-checked BEFORE the console starts; options charset-
//       guarded; no chained modules). net.egress, R4, the full Phase 5
//       three-layer pipeline.
//
// Interface note (documented deviation, see docs/EXPLOITATION.md): the build
// brief described "JSON-RPC to the MSF RPC daemon"; the real msfrpcd speaks
// MessagePack RPC and is not reachable across the container network boundary
// from the harness. msfconsole batch mode is the real, documented interface
// satisfying the same contract — one command set per tool call, one module
// per run, target in scope. Commands ride a RESOURCE FILE (msfconsole -r),
// one statement per line: every argv token stays inside the executor's
// charset guard (a -x script with spaces/semicolons could not), and the
// zod shapes (no newlines in any input) close line-injection into the file.
// Fixtures record the real msfconsole output shape; the live-binary test
// runs msfconsole when it is on PATH and skips otherwise.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { normalizeHost } from "@nyx/scope";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { resolveForExecutor, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";
import { assertSafeTokens, HostSecurityExecutor, SandboxSecurityExecutor } from "./executor.js";

const OPTION_VALUE = /^[A-Za-z0-9._:/-]+$/;
const MODULE_PATH = /^(exploit|auxiliary|post|payload|encoder|nop|evasion)\/[a-z0-9/_-]+$/;

export const MSF_SEARCH_META: SecurityToolMeta = {
  technique: "exploitation",
  rate_class: "msf",
  unit: "requests",
};

export const MSF_RUN_META: SecurityToolMeta = {
  technique: "exploitation",
  rate_class: "msf",
  unit: "requests",
};

// ---------------------------------------------------------------------------
// security.msf-search — local console queries (no target egress)
// ---------------------------------------------------------------------------

export const msfSearchInput = z
  .object({
    command: z.enum(["search", "info"]),
    /** search: free-text query. */
    query: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9 _\-:.]+$/)
      .optional(),
    /** info: full module path. */
    module: z.string().min(3).max(256).regex(MODULE_PATH).optional(),
  })
  .strict()
  .refine((i) => i.command !== "search" || i.query !== undefined, {
    message: "command 'search' requires 'query'",
    path: ["query"],
  })
  .refine((i) => i.command !== "info" || i.module !== undefined, {
    message: "command 'info' requires 'module'",
    path: ["module"],
  });

const SEARCH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", enum: ["search", "info"], description: "The local console query." },
    query: { type: "string", description: "search: module search terms." },
    module: {
      type: "string",
      description: "info: full module path (e.g. auxiliary/scanner/http/dir_scanner).",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

export interface MsfSearchRow {
  name: string;
  disclosure_date: string | null;
  rank: string | null;
  check: string | null;
  description: string;
}

/**
 * Parse msfconsole `search` output (real format — fixtures/msf-search.txt):
 *
 *   Matching Modules
 *   ================
 *      #   Name                             Disclosure Date  Rank       Check  Description
 *      -   ----                             ---------------  ----       -----  -----------
 *      0   exploit/multi/http/php_cgi_rce   2012-05-11       excellent  Yes    PHP CGI Argument Injection
 */
export function parseMsfSearch(stdout: string): MsfSearchRow[] {
  const rows: MsfSearchRow[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!/^\d+\s+(exploit|auxiliary|post|payload|encoder|nop|evasion)\//.test(t)) continue;
    const m =
      /^(\d+)\s+((?:exploit|auxiliary|post|payload|encoder|nop|evasion)\/\S+)\s+(\d{4}-\d{2}-\d{2})?\s*(\S+)?\s+(Yes|No)?\s*(.*)$/.exec(
        t,
      );
    if (m === null) continue;
    rows.push({
      name: m[2] ?? "",
      disclosure_date: m[3] ?? null,
      rank: m[4] ?? null,
      check: m[5] ?? null,
      description: m[6] ?? "",
    });
  }
  return rows;
}

export function msfSearchDefinition(): ToolDefinition {
  return {
    name: "security.msf-search",
    description:
      "Query the Metasploit module database: search modules by term or inspect one module's options and metadata. A LOCAL console query — no target traffic. Running a module is security.msf-run (which scope-checks its target).",
    input_schema: SEARCH_INPUT_SCHEMA,
    risk: "R2",
    capabilities: [],
    handler: "builtin:security.msf-search",
    timeout_ms: 600_000,
  };
}

export function msfSearchHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = msfSearchInput.parse(call.input);
      if (ctx.engagement === null) {
        return {
          kind: "text",
          text: "denied by scope: no engagement declared for this session; security tools are denied",
        };
      }
      const statements: string[] = [];
      if (input.command === "search") statements.push(`search ${input.query}`);
      if (input.command === "info") statements.push(`info ${input.module}`);
      statements.push("exit");
      // Resource file: one statement per line; the zod shapes (no newlines)
      // mean no input can inject an extra line.
      const script = statements.join("\n") + "\n";
      const scriptPath = `artifacts/msf-console-${Date.now()}.rc`;
      await ctx.sandbox.writeFile(scriptPath, script);

      const executor =
        deps.executor ??
        (deps.use_sandbox_executor === true
          ? new SandboxSecurityExecutor(ctx.sandbox)
          : new HostSecurityExecutor());
      // R2-4: the resource file must resolve where msfconsole READS it —
      // the ffuf/R3-12 rule, applied here too.
      const resolvedScriptPath = await resolveForExecutor(ctx, deps, scriptPath, "resource file");
      const result = await executor.run("msfconsole", ["-q", "-r", resolvedScriptPath], {
        timeout_ms: 600_000,
      });
      if (result.exit_code !== 0) {
        throw Object.assign(
          new Error(`msfconsole exited ${result.exit_code}: ${result.stderr.slice(0, 2000)}`),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      if (input.command === "search") {
        const rows = parseMsfSearch(result.stdout);
        return {
          kind: "json",
          json: { command: "search", query: input.query, modules: rows, count: rows.length },
        };
      }
      return { kind: "text", text: result.stdout };
    },
  };
}

// ---------------------------------------------------------------------------
// security.msf-run — one module against an authorized target
// ---------------------------------------------------------------------------

export const msfRunInput = z
  .object({
    module: z.string().min(3).max(256).regex(MODULE_PATH),
    /** The target — RHOSTS. Scope-checked before the console starts. */
    rhosts: z.string().min(3).max(256),
    /** Additional module options (charset-guarded values only). RHOSTS/
     *  RHOST are DENIED: the console applies the LAST set, and a second
     *  set would redirect the module to an unchecked host (R2-2). The
     *  scope-checked rhosts input is the only target source. */
    options: z
      .record(z.string().min(1).max(64), z.string().min(1).max(256).regex(OPTION_VALUE))
      .refine((o) => Object.keys(o).length <= 16, "at most 16 options")
      .refine(
        (o) =>
          !Object.keys(o).some((k) => k.toUpperCase() === "RHOSTS" || k.toUpperCase() === "RHOST"),
        "RHOSTS/RHOST cannot be set via options — use the (scope-checked) rhosts input",
      )
      .optional(),
  })
  .strict();

const RUN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    module: {
      type: "string",
      description: "Full module path, e.g. auxiliary/scanner/http/dir_scanner.",
    },
    rhosts: {
      type: "string",
      description: "The target — must be in engagement scope (set as RHOSTS).",
    },
    options: {
      type: "object",
      description: "Additional module options; RHOSTS is set from rhosts.",
    },
  },
  required: ["module", "rhosts"],
  additionalProperties: false,
} as const;

export function msfRunDefinition(): ToolDefinition {
  return {
    name: "security.msf-run",
    description:
      "Run ONE Metasploit module against an in-scope target: RHOSTS is scope-checked before the console starts, options are charset-guarded, and no module chains — exactly the module named, once. Requires the engagement's `exploitation` technique; R4 (owner approval) at the policy layer.",
    input_schema: RUN_INPUT_SCHEMA,
    risk: "R4",
    capabilities: ["net.egress"],
    handler: "builtin:security.msf-run",
    timeout_ms: 1_800_000,
  };
}

export function msfRunHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = msfRunInput.parse(call.input);
      // R2-5: an inline "host:port" authority is split so the port reaches
      // the scope check AND the console (RPORT), instead of being stripped.
      let rhosts = input.rhosts;
      let port: number | undefined;
      const authority = /^(.+):(\d+)$/.exec(input.rhosts);
      if (authority !== null && !input.rhosts.includes("::")) {
        rhosts = authority[1] ?? input.rhosts;
        port = Number(authority[2]);
      }
      const host = normalizeHost(rhosts);
      if (
        port !== undefined &&
        input.options?.RPORT !== undefined &&
        input.options.RPORT !== String(port)
      ) {
        throw Object.assign(
          new Error(
            `conflicting ports: rhosts says ${port}, options.RPORT says ${input.options.RPORT}`,
          ),
          { name: "SecurityToolError", code: "skill.error" as const },
        );
      }
      return runSecurityTool({
        tool: "security.msf-run",
        binary: "msfconsole",
        meta: MSF_RUN_META,
        ctx,
        deps,
        targets: [{ host, ...(port !== undefined ? { port } : {}) }],
        buildArgs: async () => {
          const statements = [
            `use ${input.module}`,
            `set RHOSTS ${host}`,
            ...(port !== undefined ? [`set RPORT ${port}`] : []),
            ...Object.entries(input.options ?? {}).map(([k, v]) => `set ${k} ${v}`),
            "run",
            "exit",
          ];
          for (const [k, v] of Object.entries(input.options ?? {})) assertSafeTokens([k, v]);
          const script = statements.join("\n") + "\n";
          const scriptPath = `artifacts/msf-run-${Date.now()}.rc`;
          await ctx.sandbox.writeFile(scriptPath, script);
          const resolved = await resolveForExecutor(ctx, deps, scriptPath, "resource file");
          return ["-q", "-r", resolved];
        },
        parse: async (stdout) => ({ kind: "text", text: stdout }),
      });
    },
  };
}
