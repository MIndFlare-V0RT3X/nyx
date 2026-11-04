// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — katana: web crawling of in-scope URLs. Output is the
// discovered-URL list (result data). Technique: web_enumeration.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const katanaInput = z
  .object({
    targets: z.array(z.string().min(3).max(2048)).min(1).max(20),
    depth: z.number().int().min(1).max(5).optional(),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    targets: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 20,
      description: "Absolute http(s) URLs to crawl (all must be in engagement scope).",
    },
    depth: { type: "integer", minimum: 1, maximum: 5, description: "Maximum crawl depth (default 2)." },
  },
  required: ["targets"],
  additionalProperties: false,
} as const;

export const KATANA_META: SecurityToolMeta = {
  technique: "web_enumeration",
  rate_class: "katana",
  unit: "requests",
};

export function katanaDefinition(): ToolDefinition {
  return {
    name: "security.katana",
    description:
      "Crawl in-scope URLs and list the discovered endpoints (standard mode — no headless browser). Every target must be inside the session's engagement scope. Returns the endpoint list; findings are not created.",
    input_schema: INPUT_SCHEMA,
    risk: "R2",
    capabilities: ["net.egress"],
    handler: "builtin:security.katana",
    timeout_ms: 900_000,
  };
}

export function katanaHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = katanaInput.parse(call.input);
      const parsed = input.targets.map((t) => parseActionUrl(t));
      if (parsed.some((p) => p === null)) {
        throw Object.assign(
          new Error("targets must be absolute http(s) URLs without userinfo"),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      const targets = parsed.map((p) => p!);
      return runSecurityTool({
        tool: "security.katana",
        binary: "katana",
        meta: KATANA_META,
        ctx,
        deps,
        targets,
        buildArgs: () => {
          const args = ["-silent", "-d", String(input.depth ?? 2), "-nc"];
          const rate = cooperativeRate(ctx.engagement!, KATANA_META);
          if (rate !== undefined) args.push("-rate-limit", String(Math.max(1, rate)));
          args.push(...targets.map((t) => t.url));
          return args;
        },
        parse: async (stdout) => {
          const urls = stdout
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          return { kind: "json", json: { urls, count: urls.length } };
        },
      });
    },
  };
}
