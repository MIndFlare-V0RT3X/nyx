// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — ffuf: web fuzzing (directories, parameters, vhosts) against
// a URL containing the FUZZ keyword. Output is the hit list (result data).
// Technique: web_enumeration.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { cooperativeRate, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";

export const ffufInput = z
  .object({
    url: z
      .string()
      .min(10)
      .max(2048)
      .regex(/^https?:\/\/[^\s]+FUZZ[^\s]*$/, "absolute http(s) URL containing the FUZZ keyword"),
    wordlist: z
      .string()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9._\-/]+$/, "workspace-relative wordlist path"),
    extensions: z.array(z.string().regex(/^[a-z0-9]{1,10}$/)).max(10).optional(),
  })
  .strict();

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      pattern: "^https?://[^\\s]+FUZZ[^\\s]*$",
      description: "Absolute http(s) URL with the FUZZ keyword in place of the segment to fuzz, e.g. https://app.example.com/portal/FUZZ",
    },
    wordlist: {
      type: "string",
      pattern: "^[A-Za-z0-9._\\-/]+$",
      description: "Workspace-relative wordlist path (e.g. wordlists/raft-small-words.txt).",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "Optional extensions appended to each word (e.g. ['.php']).",
    },
  },
  required: ["url", "wordlist"],
  additionalProperties: false,
} as const;

export const FFUF_META: SecurityToolMeta = {
  technique: "web_enumeration",
  rate_class: "ffuf",
  unit: "requests",
};

export function ffufDefinition(): ToolDefinition {
  return {
    name: "security.ffuf",
    description:
      "Web fuzzing (directories, parameters, vhosts) against an in-scope URL containing the FUZZ keyword. Rate-limited through the engagement's ffuf bucket (blocks, never drops). Returns the hit list; findings are not created — review hits and record findings with evidence.",
    input_schema: INPUT_SCHEMA,
    risk: "R3",
    capabilities: ["net.egress"],
    handler: "builtin:security.ffuf",
    timeout_ms: 900_000,
  };
}

export function ffufHandler(deps: SecurityToolDeps): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = ffufInput.parse(call.input);
      const parsed = parseActionUrl(input.url);
      if (parsed === null) {
        throw Object.assign(new Error("url must be an absolute http(s) URL"), {
          name: "SecurityToolError",
          code: "skill.error",
        });
      }
      return runSecurityTool({
        tool: "security.ffuf",
        binary: "ffuf",
        meta: FFUF_META,
        ctx,
        deps,
        targets: [parsed],
        buildArgs: () => {
          const args = ["-w", input.wordlist, "-of", "json", "-o", "/dev/stdout", "-s"];
          const rate = cooperativeRate(ctx.engagement!, FFUF_META);
          if (rate !== undefined) args.push("-rate", String(Math.max(1, rate)));
          if (input.extensions !== undefined && input.extensions.length > 0) {
            args.push("-e", input.extensions.join(","));
          }
          args.push("-u", input.url);
          return args;
        },
        parse: async (stdout) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            throw Object.assign(
              new Error(`malformed ffuf JSON output: ${stdout.slice(0, 200)}`),
              { name: "SecurityToolError", code: "skill.error" },
            );
          }
          const results = (parsed as { results?: unknown }).results;
          if (!Array.isArray(results)) {
            throw Object.assign(new Error("ffuf output has no results array"), {
              name: "SecurityToolError",
              code: "skill.error",
            });
          }
          const hits = results.map((r) => {
            const rec = r as Record<string, unknown>;
            return {
              url: typeof rec.url === "string" ? rec.url : "",
              status: typeof rec.status === "number" ? rec.status : null,
              length: typeof rec.length === "number" ? rec.length : null,
              words: typeof rec.words === "number" ? rec.words : null,
            };
          });
          return { kind: "json", json: { hits, count: hits.length } };
        },
      });
    },
  };
}
