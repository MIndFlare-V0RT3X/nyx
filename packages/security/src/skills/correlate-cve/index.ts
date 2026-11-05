// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — correlate a finding to known CVEs (fixed-host research: NVD 2.0, OSV v1, GHSA).

import { z } from "zod";
import type { ToolContext, ToolDefinition, ToolHandler, ToolOutput } from "@nyx/protocol";
import type { FindingStore } from "../../findings/store.js";
import type { SecurityToolMeta } from "../../scope/tool_filter.js";
import type { SecurityToolDeps } from "../../tools/shared.js";
import {
  createPinnedJsonFetch,
  queryCveServices,
  type CveCandidate,
  type JsonFetch,
} from "../cve_services.js";

export const CORRELATE_META: SecurityToolMeta = {
  technique: "vulnerability_scanning",
  rate_class: "cve",
  unit: "requests",
};

export const correlateCveInput = z
  .object({
    finding_id: z.string().min(1).max(128),
    /** Product (and version) the finding affects — the correlation keys. */
    product: z.string().min(1).max(128),
    version: z.string().min(1).max(64).optional(),
    /** Free-text vuln class terms ("path traversal") for confidence. */
    vuln_terms: z.array(z.string().min(1).max(64)).max(8).optional(),
  })
  .strict();

const CORRELATE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    finding_id: { type: "string", description: "The finding to correlate." },
    product: { type: "string", description: "Affected product name, e.g. 'Apache httpd'." },
    version: { type: "string", description: "Affected version, e.g. '2.4.49'." },
    vuln_terms: { type: "array", items: { type: "string" }, description: "Vulnerability class terms, e.g. ['path traversal']." },
  },
  required: ["finding_id", "product"],
  additionalProperties: false,
} as const;

export function correlateCveDefinition(): ToolDefinition {
  return {
    name: "security.correlate-cve",
    description:
      "Correlate a finding to known CVEs by querying NVD 2.0, OSV, and the GitHub Advisory Database (fixed research hosts — never engagement targets). Writes matched CVE ids + confidence (exact-match / likely / possible) back to the finding and returns the candidates. no_match is a result, not an error.",
    input_schema: CORRELATE_INPUT_SCHEMA,
    risk: "R2",
    capabilities: ["net.reference"], // fixed-host research, not engagement egress
    handler: "builtin:security.correlate-cve",
    timeout_ms: 60_000,
  };
}

export function correlateCveHandler(
  deps: SecurityToolDeps & { store: FindingStore; fetchImpl?: JsonFetch },
): ToolHandler {
  return {
    async execute(call, ctx: ToolContext): Promise<ToolOutput> {
      const input = correlateCveInput.parse(call.input);
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
      const fetchImpl =
        deps.fetchImpl ??
        createPinnedJsonFetch(deps.resolver !== undefined ? { resolver: deps.resolver } : {});
      const { candidates, queries } = await queryCveServices(
        { product: input.product, version: input.version, vuln_terms: input.vuln_terms },
        fetchImpl,
      );
      // The correlation itself is audit-logged (the queries carry
      // finding-derived terms — a visible, bounded research channel).
      deps.audit?.({
        actor: "system:security",
        action: "security.cve.query",
        payload: {
          session_id: ctx.session_id,
          engagement_id: ctx.engagement.id,
          finding_id: input.finding_id,
          product: input.product,
          queries,
        },
      });
      const cves = candidates
        .map((c) => c.cve)
        .filter((c): c is string => c !== null)
        .filter((c, i, a) => a.indexOf(c) === i);
      if (cves.length > 0) {
        await deps.store.update(input.finding_id, {
          cve: cves,
          notes:
            (finding.notes.length > 0 ? `${finding.notes}\n` : "") +
            `correlate-cve: ${cves.join(", ")} (${bestConfidence(candidates)})`,
        });
      }
      return {
        kind: "json",
        json: {
          finding_id: input.finding_id,
          cves,
          confidence: bestConfidence(candidates),
          candidates,
          result: cves.length > 0 ? "match" : "no_match",
        },
      };
    },
  };
}

function bestConfidence(candidates: CveCandidate[]): string {
  if (candidates.some((c) => c.confidence === "exact-match")) return "exact-match";
  if (candidates.some((c) => c.confidence === "likely")) return "likely";
  return "possible";
}


