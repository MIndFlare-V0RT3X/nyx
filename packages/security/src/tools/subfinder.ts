// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — subfinder: passive subdomain enumeration. Output is a
// subdomain list (result data for the next skill or an operator artifact),
// not findings. Technique: reconnaissance.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, parseJsonl, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const subfinderInput = z
  .object({
    domain: z.string().min(4).max(253).regex(/^[a-z0-9.-]+$/i, "domain name"),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    domain: { type: "string", description: "The in-scope domain to enumerate passively." },
  },
  required: ["domain"],
  additionalProperties: false,
} as const;

export const SUBFINDER_META: SecurityToolMeta = {
  technique: "reconnaissance",
  rate_class: "subfinder",
  unit: "requests",
};

export function subfinderDefinition(): ToolDefinition {
  return {
    name: "security.subfinder",
    description:
      "Passive subdomain enumeration for an in-scope domain (certificate transparency, passive DNS, configured API sources). The domain must be inside the session's engagement scope. Returns the discovered subdomain list; findings are not created — feed the list to security.httpx or store it as an artifact.",
    input_schema: INPUT_SCHEMA,
    risk: "R2",
    capabilities: ["net.egress"],
    handler: "builtin:security.subfinder",
    timeout_ms: 600_000,
  };
}

export function subfinderHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = subfinderInput.parse(call.input);
      const domain = input.domain.toLowerCase();
      return runSecurityTool({
        tool: "security.subfinder",
        binary: "subfinder",
        meta: SUBFINDER_META,
        ctx,
        deps,
        targets: [{ host: domain }],
        buildArgs: () => {
          const args = ["-d", domain, "-json", "-silent", "-nc"];
          const rate = cooperativeRate(ctx.engagement!, SUBFINDER_META);
          if (rate !== undefined) args.push("-rl", String(Math.max(1, rate)));
          return args;
        },
        parse: async (stdout) => {
          const records = parseJsonl(stdout) as Array<{ host?: unknown; source?: unknown }>;
          const hosts = [
            ...new Set(
              records
                .map((r) => (typeof r.host === "string" ? r.host.toLowerCase() : ""))
                .filter((h) => h.length > 0),
            ),
          ];
          return { kind: "json", json: { domain, subdomains: hosts, count: hosts.length } };
        },
      });
    },
  };
}
