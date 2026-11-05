// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — the smallest reproduction — subset-only reduction, never a fabricated one.

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import type { FindingStore } from "../../findings/store.js";
import type { SecurityToolMeta } from "../../scope/tool_filter.js";
import type { SecurityToolDeps } from "../../tools/shared.js";

export const MINIMIZE_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "cve",
  unit: "requests",
};

export const minimizePocInput = z
  .object({
    finding_id: z.string().min(1).max(128),
    /** The raw PoC to reduce — an HTTP request (or any line-oriented text).
     *  Defaults to the finding's reproduction field. */
    poc: z.string().min(1).max(65_536).optional(),
    /** Tokens whose lines are load-bearing (the payload, its host, etc.).
     *  A line survives iff it carries a required token, is the request
     *  line, or is blank-line structure. Everything else is removable. */
    required_tokens: z.array(z.string().min(1).max(256)).min(1).max(16),
  })
  .strict();

const MINIMIZE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string", description: "The finding the PoC reproduces." },
    poc: {
      type: "string",
      description:
        "The raw PoC (an HTTP request or line-oriented text); defaults to the finding's reproduction field.",
    },
    required_tokens: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description: "Tokens whose containing lines must survive (the trigger payload etc.).",
    },
  },
  required: ["finding_id", "required_tokens"],
  additionalProperties: false,
} as const;

export function minimizePocDefinition(): ToolDefinition {
  return {
    name: "security.minimize-poc",
    description:
      "Reduce a PoC to the MINIMUM reproduction: lines are only ever DELETED (the output is a subset of the input — it cannot fabricate a smaller PoC that was never tested). Lines carrying required tokens, the request line, and structure survive; everything else goes. Returns cannot_minimize when nothing can be removed — a reduction that would require MODIFYING a line is a fabrication and is refused.",
    input_schema: MINIMIZE_INPUT_SCHEMA,
    risk: "R2",
    capabilities: [], // local reduction over recorded text
    handler: "builtin:security.minimize-poc",
    timeout_ms: 60_000,
  };
}

export interface MinimizeResult {
  result: "minimized" | "cannot_minimize";
  original_lines: number;
  minimized_lines: number | null;
  minimized_poc: string | null;
  removed: string[];
  note: string;
}

/**
 * The subset reducer: pure line deletion. The request line (first
 * non-empty line) always survives; blank lines survive (structure); a line
 * with any required token survives. Anything else is removable.
 */
export function minimizePocLines(poc: string, requiredTokens: string[]): MinimizeResult {
  const lines = poc.split("\n");
  const tokens = requiredTokens.filter((t) => t.length > 0);
  // The first non-empty line is the request/target line — always load-bearing.
  let firstNonEmpty = lines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmpty === -1) firstNonEmpty = 0;
  // R3-10: the BODY (everything after the first blank line) is a unit — if
  // any body line survives (carries a token), the whole body block plus its
  // structural headers (Content-Length, Content-Type) survive. A body-less
  // POST would be a fabricated non-reproducing PoC.
  const firstBlank = lines.findIndex((l) => l.trim().length === 0);
  const bodyStart = firstBlank === -1 ? lines.length : firstBlank + 1;
  const bodyLines = lines.slice(bodyStart);
  const bodyHasToken = bodyLines.some((l) => tokens.some((t) => l.includes(t)));
  const STRUCTURAL_BODY_HEADERS = /^(content-length|content-type|transfer-encoding):/i;
  const kept: string[] = [];
  const removed: string[] = [];
  lines.forEach((line, i) => {
    const isBody = i >= bodyStart;
    const loadBearing =
      i === firstNonEmpty ||
      line.trim().length === 0 ||
      /^host:/i.test(line.trim()) || // an HTTP request without Host is invalid
      (bodyHasToken && isBody) ||
      (bodyHasToken && STRUCTURAL_BODY_HEADERS.test(line.trim())) ||
      tokens.some((t) => line.includes(t));
    if (loadBearing) kept.push(line);
    else removed.push(line);
  });
  if (removed.length === 0) {
    return {
      result: "cannot_minimize",
      original_lines: lines.length,
      minimized_lines: null,
      minimized_poc: null,
      removed: [],
      note:
        "every line is load-bearing (request line, structure, or a required token) — " +
        "reducing further would require MODIFYING a line, which would fabricate a PoC " +
        "that was never tested; refused",
    };
  }
  const minimized = kept.join("\n");
  return {
    result: "minimized",
    original_lines: lines.length,
    minimized_lines: kept.length,
    minimized_poc: minimized,
    removed,
    note:
      "the output is a strict subset of the input (only line deletions); it is a " +
      "minimum DEMONSTRATION — re-verify it still reproduces before disclosure",
  };
}

export function minimizePocHandler(deps: SecurityToolDeps & { store: FindingStore }): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = minimizePocInput.parse(call.input);
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
      const poc = input.poc ?? finding.reproduction;
      if (poc.trim().length === 0) {
        throw Object.assign(
          new Error(
            "the finding's reproduction is empty and no poc was supplied — nothing to minimize",
          ),
          { name: "SecurityToolError", code: "skill.error" },
        );
      }
      const result = minimizePocLines(poc, input.required_tokens);
      return { kind: "json", json: { finding_id: input.finding_id, ...result } };
    },
  };
}
