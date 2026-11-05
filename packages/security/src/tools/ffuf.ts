// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 5 §3.1 — ffuf: web fuzzing (directories, parameters, vhosts) against
// a URL containing the FUZZ keyword. Output is the hit list (result data).
// Technique: web_enumeration.

import { z } from "zod";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import { parseActionUrl } from "../engagement/matcher.js";
import type { SecurityToolMeta } from "../scope/tool_filter.js";
import { assertWorkspacePath, cooperativeRate, egressProxyUrl, runSecurityTool } from "./shared.js";
import type { SecurityToolDeps } from "./shared.js";
import { HostSecurityExecutor } from "./executor.js";

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
      .regex(/^[A-Za-z0-9._\-/]+$/, "workspace wordlist path")
      .refine(
        // The runtime rewrites to absolute-under-workdir; both forms are
        // legitimate, `..` never is (containment also rejects it upstream).
        (p) => !p.split("/").includes(".."),
        "wordlist must contain no .. segments",
      ),
    extensions: z
      .array(z.string().regex(/^\.?[a-z0-9]{1,10}$/, "extension like '.php' or 'php'"))
      .max(10)
      .optional(),
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
      items: { type: "string", pattern: "^\\.?[a-z0-9]{1,10}$" },
      description: "Optional extensions appended to each word (e.g. ['.php'] — the dot is added if missing).",
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
        buildArgs: async () => {
          // -json: newline-delimited JSON records on stdout; -s keeps the
          // per-match quiet printout the ONLY other stdout content, and the
          // record stream is what we parse (R3-6: -o/-of json on /dev/stdout
          // is unusable — quiet mode prints matched words to stdout and the
          // final file write would append to them).
          const args = ["-json", "-s"];
          const rate = cooperativeRate(ctx.engagement!, FFUF_META);
          if (rate !== undefined) args.push("-rate", String(Math.max(1, rate)));
          // Phase 6.1: ffuf honors an explicit proxy flag — point it at the
          // engagement's ffuf-class listener so the per-class limit is
          // enforced AT THE PROXY (the container env already carries the
          // default listener for env-honoring tools; ffuf's explicit flag
          // wins and gets the class attribution).
          const proxy = egressProxyUrl(ctx, "ffuf");
          if (proxy !== undefined) args.push("-x", proxy);
          if (input.extensions !== undefined && input.extensions.length > 0) {
            // ffuf appends the extension verbatim — the DOT is required.
            args.push("-e", input.extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)).join(","));
          }
          // R3-12 (closed Phase 6.2): the wordlist path must resolve where
          // the BINARY will read it, not where the containment check ran.
          // Sandbox executor: cwd is the workspace — pass the workspace-
          // relative path unchanged. Real host executor: resolve to an
          // ABSOLUTE path from the harness cwd and fail LOUDLY if missing,
          // instead of letting ffuf die on a confusing "no such file".
          // (An injected executor — tests — gets the path verbatim.)
          const wordlist = assertWorkspacePath(ctx, input.wordlist, "wordlist");
          const realHost =
            deps.executor instanceof HostSecurityExecutor ||
            (deps.executor === undefined && deps.use_sandbox_executor !== true);
          if (realHost) {
            // After the runtime's containment rewrite the path is absolute
            // under the SANDBOX workdir; on the host that only exists with
            // the local provider (its workdir IS a host dir). The docker+
            // host combination cannot address workspace files — R3-12's
            // closure: fail LOUDLY with the turnkey recommendation instead
            // of ffuf's confusing "no such file".
            const absolute = path.resolve(ctx.sandbox.workdir, wordlist);
            try {
              const stat = await fsp.stat(absolute);
              if (!stat.isFile()) throw new Error("not a file");
            } catch {
              throw Object.assign(
                new Error(
                  `wordlist "${wordlist}" is not readable on the host at ${absolute} ` +
                    "(the host executor only addresses workspace files with the local provider). " +
                    "Use the sandbox executor (security.executor: \"sandbox\") — the turnkey live " +
                    "mode since the Phase 6.1 egress proxy.",
                ),
                { name: "SecurityToolError", code: "skill.error" as const },
              );
            }
            args.push("-w", absolute);
          } else {
            args.push("-w", wordlist);
          }
          args.push("-u", input.url);
          return args;
        },
        parse: async (stdout) => {
          // -json emits one JSON record per match (newline-delimited).
          // Quiet-mode matched-word lines are plain words, not JSON — only
          // lines starting with '{' are parsed as records (R3-6).
          const hits: Array<{ url: string; status: number | null; length: number | null; words: number | null }> = [];
          for (const line of stdout.split("\n")) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;
            if (!trimmed.startsWith("{")) continue; // quiet matched-word line
            let rec: Record<string, unknown>;
            try {
              rec = JSON.parse(trimmed) as Record<string, unknown>;
            } catch {
              throw Object.assign(
                new Error(`malformed ffuf JSON record: ${trimmed.slice(0, 200)}`),
                { name: "SecurityToolError", code: "skill.error" },
              );
            }
            hits.push({
              url: typeof rec.url === "string" ? rec.url : "",
              status: typeof rec.status === "number" ? rec.status : null,
              length: typeof rec.length === "number" ? rec.length : null,
              words: typeof rec.words === "number" ? rec.words : null,
            });
          }
          return { kind: "json", json: { hits, count: hits.length } };
        },
      });
    },
  };
}
