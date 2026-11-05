// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — httpx: HTTP probing and tech fingerprinting. Output is a
// probe-result list (result data), not findings. Technique: web_enumeration.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, parseJsonl, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const httpxInput = z
  .object({
    targets: z.array(z.string().min(3).max(2048)).min(1).max(100),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 100,
      description: "Hosts or absolute http(s) URLs to probe (all must be in engagement scope).",
    },
  },
  required: ["targets"],
  additionalProperties: false,
} as const;

export const HTTPX_META: SecurityToolMeta = {
  technique: "web_enumeration",
  rate_class: "httpx",
  unit: "requests",
};

export function httpxDefinition(): ToolDefinition {
  return {
    name: "security.httpx",
    description:
      "Probe HTTP(S) targets for live services, status codes, titles, and technology fingerprints. Every target must be inside the session's engagement scope (URL targets are matched on scheme+host+path). Returns a structured probe list; findings are not created — feed live URLs to security.nuclei or security.katana.",
    input_schema: INPUT_SCHEMA,
    risk: "R2",
    capabilities: ["net.egress"],
    handler: "builtin:security.httpx",
    timeout_ms: 600_000,
  };
}

export function httpxHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = httpxInput.parse(call.input);
      const parsed = input.targets.map((t) => parseActionUrl(t));
      if (parsed.some((p) => p === null)) {
        throw Object.assign(
          new Error(
            "targets must be hosts or absolute http(s) URLs without userinfo",
          ),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      const targets = parsed.map((p) => p!);
      return runSecurityTool({
        tool: "security.httpx",
        binary: "httpx",
        meta: HTTPX_META,
        ctx,
        deps,
        targets,
        buildArgs: () => {
          const args = ["-json", "-silent", "-title", "-tech-detect", "-status-code"];
          const rate = cooperativeRate(ctx.engagement!, HTTPX_META);
          if (rate !== undefined) args.push("-rate-limit", String(Math.max(1, rate)));
          // goflags stops parsing at the first non-flag token: targets go
          // through repeated -u flags, never as positional args (R3-1/2/3).
          for (const t of targets) args.push("-u", t.url);
          return args;
        },
        parse: async (stdout) => {
          const records = parseJsonl(stdout) as Array<Record<string, unknown>>;
          const probes = records.map((r) => ({
            url: typeof r.url === "string" ? r.url : "",
            status: typeof r.status_code === "number" ? r.status_code : null,
            title: typeof r.title === "string" ? r.title : null,
            tech: Array.isArray(r.tech) ? (r.tech as string[]) : [],
            web_server: typeof r.webserver === "string" ? r.webserver : null,
            content_type: typeof r.content_type === "string" ? r.content_type : null,
          }));
          return { kind: "json", json: { probes, count: probes.length } };
        },
      });
    },
  };
}
