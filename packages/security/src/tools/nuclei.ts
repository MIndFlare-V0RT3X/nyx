// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — nuclei: template-based vulnerability scanning. THE tool
// that produces Finding entries: every matched template becomes a finding
// bound to the session's engagement (createInSession — the structural
// provenance), with the run's raw JSONL output written into the sandbox
// artifacts/ directory and hash-recorded as the finding's evidence
// (hard rule #5: no finding without a hash-verified artifact).
// Technique: vulnerability_scanning.

import { createHash } from "node:crypto";
import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { Finding, FindingSeverity } from "../findings/schema.js";
import { scoreCvss3Vector } from "../findings/cvss3.js";
import { scoreCvss4 } from "../findings/cvss4.js";
import type { FindingStore } from "../findings/store.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, parseJsonl, resolveForExecutor, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const nucleiInput = z
  .object({
    targets: z.array(z.string().min(3).max(2048)).min(1).max(50),
    templates: z
      .string()
      .regex(/^[a-z0-9-]+(,[a-z0-9-]+)*$/, "comma-separated template tags")
      .optional(),
    /** Phase 6.2: ONE custom workspace template (nuclei-template-from-finding
     *  output) — -t <path>. The runtime contains it like ffuf's wordlist. */
    template: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9._\-/]+$/, "workspace template path")
      .refine((p) => !p.split("/").includes(".."), "template must contain no .. segments")
      .optional(),
    severity: z
      .array(z.enum(["critical", "high", "medium", "low", "info"]))
      .max(5)
      .optional(),
  })
  .strict()
  .refine((i) => i.templates === undefined || i.template === undefined, {
    message:
      "templates (tags) and template (a file) are mutually exclusive — nuclei's -tags filter would silently filter out the custom template",
    path: ["template"],
  });

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 50,
      description: "Absolute http(s) URLs to scan (all must be in engagement scope).",
    },
    templates: {
      type: "string",
      pattern: "^[a-z0-9-]+(,[a-z0-9-]+)*$",
      description: "Optional comma-separated nuclei template tags (e.g. 'cve,poc').",
    },
    template: {
      type: "string",
      pattern: "^[A-Za-z0-9._\\-/]+$",
      description:
        "Optional ONE custom template file (workspace-relative, e.g. artifacts/nuclei-templates/finding-123.yaml) — the output of security.nuclei-template. Exclusive with 'templates'.",
    },
    severity: {
      type: "array",
      items: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
      description: "Optional severity filter for matched templates.",
    },
  },
  required: ["targets"],
  additionalProperties: false,
} as const;

export const NUCLEI_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "nuclei",
  unit: "requests",
};

const SEVERITIES: readonly FindingSeverity[] = ["critical", "high", "medium", "low", "info"];

export function nucleiDefinition(): ToolDefinition {
  return {
    name: "security.nuclei",
    description:
      "Template-based vulnerability scanning against in-scope URLs. Every matched template becomes a Finding in the engagement's findings database (severity, CVSS when the template classifies one, matched URL, evidence pointing at the run's hash-recorded raw output artifact). Requires the vulnerability_scanning technique in the engagement.",
    input_schema: INPUT_SCHEMA,
    risk: "R3",
    capabilities: ["net.egress"],
    handler: "builtin:security.nuclei",
    timeout_ms: 900_000,
  };
}

/**
 * Real nuclei -jsonl records use DASHED keys (template-id, matched-at,
 * info.classification.{cve-id,cwe-id,cvss-metrics}) and ARRAYS for the id
 * fields; the underscored variants are tolerated defensively (R3-4).
 */
interface NucleiMatch {
  info?: {
    name?: unknown;
    severity?: unknown;
    description?: unknown;
    classification?: Record<string, unknown>;
  };
  "matched-at"?: unknown;
  matched_at?: unknown;
  "template-id"?: unknown;
  template_id?: unknown;
  host?: unknown;
}

function pick(a: unknown, b: unknown): unknown {
  return a !== undefined ? a : b;
}

/** Real output ids are StringSlices; accept a string or the first array entry. */
function asId(v: unknown): string | undefined {
  if (typeof v === "string" && v.length > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "string" && (v[0] as string).length > 0) {
    return v[0] as string;
  }
  return undefined;
}

export function nucleiHandler(deps: SecurityToolDeps & { store: FindingStore }): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = nucleiInput.parse(call.input);
      const parsed = input.targets.map((t) => parseActionUrl(t));
      if (parsed.some((p) => p === null)) {
        throw Object.assign(new Error("targets must be absolute http(s) URLs without userinfo"), {
          name: "SecurityToolError",
          code: "skill.error",
        });
      }
      const targets = parsed.map((p) => p!);
      return runSecurityTool({
        tool: "security.nuclei",
        binary: "nuclei",
        meta: NUCLEI_META,
        ctx,
        deps,
        targets,
        buildArgs: async () => {
          const args = ["-jsonl", "-silent", "-nc"];
          if (input.templates !== undefined) args.push("-tags", input.templates);
          if (input.template !== undefined) {
            // R2-4: resolve per executor mode (sandbox: relative; host: the
            // ffuf/R3-12 rule with a loud failure).
            args.push("-t", await resolveForExecutor(ctx, deps, input.template, "template"));
          }
          if (input.severity !== undefined && input.severity.length > 0) {
            args.push("-severity", input.severity.join(","));
          }
          const rate = cooperativeRate(ctx.engagement!, NUCLEI_META);
          if (rate !== undefined) args.push("-rl", String(Math.max(1, rate)));
          // goflags stops parsing at the first non-flag token: targets go
          // through repeated -u flags, never as positional args (R3-1/2/3).
          for (const t of targets) args.push("-u", t.url);
          return args;
        },
        parse: async (stdout, ctx2: ToolContext) => {
          const records = parseJsonl(stdout) as NucleiMatch[];
          if (records.length === 0) {
            return { kind: "json", json: { findings: [], count: 0 } };
          }
          // The run's raw output IS the evidence artifact: written into the
          // sandbox artifacts/ dir, sha256-recorded per finding.
          const artifactName = `nuclei-${Date.now()}.jsonl`;
          const artifactPath = `artifacts/${artifactName}`;
          await ctx2.sandbox.writeFile(artifactPath, stdout);
          const artifactHash = createHash("sha256").update(stdout, "utf8").digest("hex");
          const evidence = [
            { path: artifactPath, hash: artifactHash, mime: "application/x-ndjson" },
          ];

          const findings: Array<{ id: string; title: string; severity: string; target: unknown }> =
            [];
          for (const m of records) {
            const severity = SEVERITIES.includes(m.info?.severity as FindingSeverity)
              ? (m.info!.severity as FindingSeverity)
              : "info";
            const templateIdRaw = asId(pick(m["template-id"], m.template_id)) ?? "unknown-template";
            const templateId = templateIdRaw;
            const name =
              typeof m.info?.name === "string" && m.info.name.length > 0
                ? m.info.name
                : `nuclei ${templateId}`;
            const matchedAtRaw = pick(m["matched-at"], m.matched_at);
            const matchedAt =
              typeof matchedAtRaw === "string" && matchedAtRaw.length > 0
                ? matchedAtRaw
                : typeof m.host === "string" && m.host.length > 0
                  ? m.host
                  : "";
            let target: Finding["target"];
            try {
              const u = new URL(matchedAt);
              target = {
                host: u.hostname.toLowerCase(),
                ...(u.port !== "" ? { port: Number(u.port) } : {}),
                ...(u.pathname !== "/" ? { path: u.pathname } : {}),
              };
            } catch {
              target = { host: matchedAt.toLowerCase() };
            }
            const cls = m.info?.classification;
            const metricsRaw = pick(cls?.["cvss-metrics"], cls?.cvss_metrics);
            const metrics = typeof metricsRaw === "string" ? metricsRaw : undefined;
            const cvss3Vector = metrics?.startsWith("CVSS:3.1") ? metrics : undefined;
            const cvss4Vector = metrics?.startsWith("CVSS:4.0") ? metrics : undefined;
            // A malformed vector in one match must not abort the remaining
            // matches (R2-10) — the finding lands without a CVSS score.
            const safeScore = (fn: () => number): number | undefined => {
              try {
                return fn();
              } catch {
                return undefined;
              }
            };
            const cveId = asId(pick(cls?.["cve-id"], cls?.cve_id));
            const cve = cveId !== undefined ? [cveId.toUpperCase()] : undefined;
            const cweId = asId(pick(cls?.["cwe-id"], cls?.cwe_id));
            const cwe =
              cweId !== undefined
                ? [
                    `CWE-${cweId
                      .replace(/^CWE-?/i, "")
                      .replace(/^\d+$/, (d) => d)
                      .toUpperCase()}`,
                  ]
                : undefined;
            const created = await deps.store.createInSession(
              { session_id: ctx2.session_id, engagement: ctx2.engagement },
              {
                title: name,
                description:
                  typeof m.info?.description === "string" && m.info.description.length > 0
                    ? m.info.description
                    : `nuclei template ${templateId} matched at ${matchedAt}`,
                severity,
                ...(cvss3Vector !== undefined
                  ? { cvss_3_1: safeScore(() => scoreCvss3Vector(cvss3Vector)) }
                  : {}),
                ...(cvss4Vector !== undefined
                  ? { cvss_4_0: safeScore(() => scoreCvss4(cvss4Vector)) }
                  : {}),
                ...(cve !== undefined ? { cve } : {}),
                ...(cwe !== undefined ? { cwe } : {}),
                target,
                evidence,
                reproduction: `Re-run security.nuclei against ${matchedAt} (template ${templateId}); the raw match is in ${artifactPath}.`,
                remediation:
                  "Consult the template's references and the affected component's vendor advisory; verify the match before remediating.",
                status: "open",
                discovered_by: "nuclei/security.nuclei",
                notes: "",
              },
            );
            findings.push({
              id: created.id,
              title: created.title,
              severity: created.severity,
              target: created.target,
            });
          }
          return {
            kind: "json",
            json: {
              artifact: artifactPath,
              sha256: artifactHash,
              findings,
              count: findings.length,
            },
          };
        },
      });
    },
  };
}
