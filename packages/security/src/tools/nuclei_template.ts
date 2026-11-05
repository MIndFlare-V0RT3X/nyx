// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.2 §3.2 — nuclei-template-from-finding: turn a discovered pattern
// into a repeatable nuclei v3 check. The tool reads the finding, validates
// the reproduction request's host against the SAME engagement's scope (the
// generated template is only ever for an authorized target), composes the
// template in nuclei's real YAML format, writes it into the workspace and
// hash-records it. Running it is security.nuclei's `template` input.

import { createHash } from "node:crypto";
import { z } from "zod";
import { stringify as stringifyYaml } from "yaml";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { checkUrl, parseActionUrl } from "../engagement/matcher.js";
import type { FindingStore } from "../findings/store.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import type { SecurityToolDeps } from "./shared.js";

const TEMPLATE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const nucleiTemplateInput = z
  .object({
    finding_id: z.string().min(1).max(128),
    /** The exact request that reproduces the finding. */
    request: z
      .object({
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        url: z
          .string()
          .min(10)
          .max(2048)
          .regex(/^https?:\/\//, "absolute http(s) URL"),
        headers: z
          .record(z.string().min(1).max(128), z.string().max(4096))
          .refine((h) => Object.keys(h).length <= 32, "at most 32 headers")
          .optional(),
        body: z.string().max(16_384).optional(),
      })
      .strict(),
    /** What proves the issue — at least one matcher. */
    matchers: z
      .object({
        status: z.array(z.number().int().min(100).max(599)).min(1).max(16).optional(),
        words: z.array(z.string().min(1).max(256)).min(1).max(16).optional(),
        regex: z.array(z.string().min(1).max(256)).min(1).max(16).optional(),
      })
      .strict()
      .refine(
        (m) =>
          (m.status !== undefined && m.status.length > 0) ||
          (m.words !== undefined && m.words.length > 0) ||
          (m.regex !== undefined && m.regex.length > 0),
        "at least one matcher (status, words, or regex) is required",
      ),
    /** Defaults to the finding's severity. */
    severity: z.enum(["critical", "high", "medium", "low", "info"]).optional(),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: {
      type: "string",
      description: "The finding this check encodes (its target must be in scope).",
    },
    request: {
      type: "object",
      description: "The minimal request that reproduces the finding.",
      properties: {
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        },
        url: { type: "string", description: "Absolute http(s) URL of the affected endpoint." },
        headers: { type: "object", description: "Optional additional headers." },
        body: { type: "string", description: "Optional request body." },
      },
      required: ["method", "url"],
      additionalProperties: false,
    },
    matchers: {
      type: "object",
      description: "Detection criteria: at least one of status / words / regex.",
      properties: {
        status: { type: "array", items: { type: "integer" }, description: "HTTP status codes." },
        words: {
          type: "array",
          items: { type: "string" },
          description: "Words that must appear in the response.",
        },
        regex: {
          type: "array",
          items: { type: "string" },
          description: "Regexes that must match the response.",
        },
      },
      additionalProperties: false,
    },
    severity: { type: "string", enum: ["critical", "high", "medium", "low", "info"] },
  },
  required: ["finding_id", "request", "matchers"],
  additionalProperties: false,
} as const;

export const NUCLEI_TEMPLATE_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "nuclei",
  unit: "requests",
};

export function nucleiTemplateDefinition(): ToolDefinition {
  return {
    name: "security.nuclei-template",
    description:
      "Author a nuclei v3 YAML template from a finding: the minimal reproducing request plus match criteria become a repeatable check, written to the workspace and hash-recorded. The request's host must be inside the finding's engagement scope. Run the result with security.nuclei's `template` input.",
    input_schema: INPUT_SCHEMA,
    risk: "R2",
    capabilities: [], // local composition: the request is recorded, not fired here
    handler: "builtin:security.nuclei-template",
    timeout_ms: 60_000,
  };
}

export interface NucleiTemplateDoc {
  id: string;
  info: Record<string, unknown>;
  http: Array<Record<string, unknown>>;
}

/** Compose the nuclei v3 template document (real format). */
export function buildNucleiTemplate(opts: {
  findingId: string;
  findingTitle: string;
  findingDescription: string;
  severity: string;
  cve?: string[];
  cwe?: string[];
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
  };
  matchers: { status?: number[]; words?: string[]; regex?: string[] };
}): NucleiTemplateDoc {
  const u = new URL(opts.request.url);
  // {{BaseURL}} carries the target; the template carries the path.
  const path = `${u.pathname}${u.search}`;
  const slug = opts.findingId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const matchers: Array<Record<string, unknown>> = [];
  if (opts.matchers.status !== undefined) {
    matchers.push({ type: "status", status: opts.matchers.status });
  }
  if (opts.matchers.words !== undefined) {
    matchers.push({ type: "word", words: opts.matchers.words });
  }
  if (opts.matchers.regex !== undefined) {
    matchers.push({ type: "regex", regex: opts.matchers.regex });
  }
  return {
    id: TEMPLATE_ID_RE.test(slug) ? `nyx-${slug}` : `nyx-finding`,
    info: {
      name: opts.findingTitle,
      author: "nyx (nuclei-template-from-finding)",
      severity: opts.severity,
      description: opts.findingDescription,
      ...(opts.cve !== undefined && opts.cve.length > 0
        ? { classification: { "cve-id": opts.cve.map((c) => c.toUpperCase()) } }
        : {}),
      ...(opts.cwe !== undefined && opts.cwe.length > 0
        ? { reference: [], tags: ["nyx", "finding"] }
        : { tags: ["nyx", "finding"] }),
    },
    http: [
      {
        method: opts.request.method,
        path: ["{{BaseURL}}" + (path === "" ? "/" : path)],
        ...(opts.request.headers !== undefined && Object.keys(opts.request.headers).length > 0
          ? { headers: opts.request.headers }
          : {}),
        ...(opts.request.body !== undefined ? { body: opts.request.body } : {}),
        "matchers-condition": "and",
        matchers,
      },
    ],
  };
}

export function nucleiTemplateHandler(
  deps: SecurityToolDeps & { store: FindingStore },
): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = nucleiTemplateInput.parse(call.input);
      const finding = await deps.store.get(input.finding_id);
      if (finding === null) {
        throw Object.assign(new Error(`finding ${input.finding_id} not found`), {
          name: "SecurityToolError",
          code: "skill.error",
        });
      }
      if (ctx.engagement === null || ctx.engagement.id !== finding.engagement_id) {
        throw Object.assign(
          new Error(
            `finding ${input.finding_id} belongs to engagement ${finding.engagement_id}, not this session's — cross-engagement tooling is denied`,
          ),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      // Scope gate: the reproduction request's target must be authorized by
      // the SAME engagement the finding belongs to.
      const parsed = parseActionUrl(input.request.url);
      if (parsed === null) {
        throw Object.assign(
          new Error("request.url must be an absolute http(s) URL without userinfo"),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      const verdict = checkUrl(ctx.engagement, input.request.url);
      if (!verdict.allowed) {
        throw Object.assign(
          new Error(`the reproduction request's target is out of scope: ${verdict.reason}`),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }

      const doc = buildNucleiTemplate({
        findingId: finding.id,
        findingTitle: finding.title,
        findingDescription: finding.description,
        severity: input.severity ?? finding.severity,
        cve: finding.cve,
        cwe: finding.cwe,
        request: input.request,
        matchers: input.matchers,
      });
      const yaml = stringifyYaml(doc);
      const path = `artifacts/nuclei-templates/${finding.id}.yaml`;
      await ctx.sandbox.writeFile(path, yaml);
      const hash = createHash("sha256").update(yaml).digest("hex");
      return {
        kind: "json",
        json: {
          template_id: doc.id,
          path,
          sha256: hash,
          template: yaml,
          run_with: {
            tool: "security.nuclei",
            input: { targets: [input.request.url], template: path },
          },
        },
      };
    },
  };
}
