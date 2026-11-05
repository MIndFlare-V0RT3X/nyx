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
    vuln_terms: {
      type: "array",
      items: { type: "string" },
      description: "Vulnerability class terms, e.g. ['path traversal'].",
    },
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
      // R3-9: the research traffic charges the engagement's `cve` rate class
      // (per service host, per request) — the declared class is enforced,
      // not dead metadata.
      const baseFetch =
        deps.fetchImpl ??
        createPinnedJsonFetch(deps.resolver !== undefined ? { resolver: deps.resolver } : {});
      const fetchImpl: JsonFetch = async (url, init) => {
        if (ctx.engagement !== null) {
          await deps.limiter.acquire({
            engagement: ctx.engagement,
            tool_class: "cve",
            host: new URL(url).hostname,
            unit: "requests",
          });
        }
        return baseFetch(url, init);
      };
      // R3-5: the audit row is written EVEN WHEN the queries throw (the
      // queries carry finding-derived terms out — the log must reflect
      // every fired query attempt).
      // R3-5: track every query that FIRES (including failed attempts) —
      // the audit row must survive errors and teardown.
      const firedQueries: string[] = [];
      const trackingFetch: JsonFetch = async (url, init) => {
        firedQueries.push(init?.method === "POST" ? `${url} (POST)` : url);
        return fetchImpl(url, init);
      };
      let outcome: Awaited<ReturnType<typeof queryCveServices>>;
      try {
        outcome = await queryCveServices(
          { product: input.product, version: input.version, vuln_terms: input.vuln_terms },
          trackingFetch,
        );
      } finally {
        deps.audit?.({
          actor: "system:security",
          action: "security.cve.query",
          payload: {
            session_id: ctx.session_id,
            engagement_id: ctx.engagement?.id ?? null,
            finding_id: input.finding_id,
            product: input.product,
            version: input.version ?? null,
            queries: firedQueries,
          },
        });
      }
      const { candidates, service_status } = outcome;
      // R3-8: CVE-less advisories still count — "match" is about evidence,
      // not the registry id.
      const cves = [
        ...new Set(candidates.map((c) => c.cve).filter((c): c is string => c !== null)),
      ];
      const advisories = [...new Set(candidates.filter((c) => c.cve === null).map((c) => c.url))];
      const allServicesOk =
        service_status.nvd === "ok" && service_status.osv === "ok" && service_status.ghsa === "ok";
      const matched = cves.length > 0 || advisories.length > 0;
      if (matched) {
        // R3-3: MERGE with the finding's existing CVEs (correlation is
        // additive; a second run must never erase the first).
        // R3-11: re-read right before the update (the network round-trip
        // window is seconds wide).
        const fresh = await deps.store.get(input.finding_id);
        const existing = fresh?.cve ?? [];
        const merged = [...new Set([...existing, ...cves])];
        // R3-12: per-CVE confidence (not one label for the whole list).
        const perCve = cves.map((cve) => {
          const best = candidates
            .filter((c) => c.cve === cve)
            .map((c) => c.confidence)
            .sort()[0];
          return `${cve} (${best ?? "possible"})`;
        });
        // R3-6: the correlated PRODUCT persists on the finding — submit-cve
        // needs the real product, not the target host.
        await deps.store.update(input.finding_id, {
          cve: merged,
          notes:
            ((fresh?.notes.length ?? 0) > 0 ? `${fresh!.notes}\n` : "") +
            `correlated-product: ${input.product}${input.version !== undefined ? ` ${input.version}` : ""}` +
            (perCve.length > 0 ? `\ncorrelate-cve: ${perCve.join(", ")}` : ""),
        });
      }
      return {
        kind: "json",
        json: {
          finding_id: input.finding_id,
          cves,
          advisories,
          confidence: bestConfidence(candidates),
          service_status,
          result: matched ? "match" : allServicesOk ? "no_match" : "service_error",
          candidates,
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
