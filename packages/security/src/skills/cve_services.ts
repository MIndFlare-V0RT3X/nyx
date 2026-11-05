// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 6.3 §4.2 — the fixed-host CVE research services.
//
// CVE correlation queries PUBLIC advisory databases — nvd.nist.gov,
// api.osv.dev, api.github.com — which are NOT engagement targets. These are
// harness-level RESEARCH endpoints, hard-pinned in code (the caller cannot
// steer the host, the path, or the query beyond product/version terms), and
// every query is audit-logged (security.cve.query). No engagement-target
// egress happens here; the fixed host list is the whole surface.
//
// Query shapes are the services' real documented APIs:
//   NVD 2.0:  GET  /rest/json/cves/2.0?keywordSearch=<product + terms>
//   OSV v1:   POST /v1/query  {"package":{"name":<product>},"version"?}
//   GHSA:     GET  /advisories?cve_id=<id>   (enrichment of found CVEs —
//             the REST API filters by id, it has no free-text search)
// The fixtures under fixtures/ mirror the real response shapes; the tests
// inject them through `fetchImpl`.

import { request as httpsRequest } from "node:https";
import type { EgressResolver } from "@nyx/tools";

/** The complete fixed allowlist — no caller input ever changes these. */
export const CVE_SERVICE_HOSTS = {
  nvd: "nvd.nist.gov",
  osv: "api.osv.dev",
  ghsa: "api.github.com",
} as const;

export type CveService = keyof typeof CVE_SERVICE_HOSTS;

/** Minimal fetch surface (injectable; production pins DNS per host). */
export type JsonFetch = (
  url: string,
  init?: { method?: "GET" | "POST"; body?: string },
) => Promise<unknown>;

export interface CveServicesDeps {
  resolver?: EgressResolver;
}

export interface CveServiceQuery {
  product: string;
  version?: string;
  /** Vulnerability class terms (e.g. "path traversal") for confidence. */
  vuln_terms?: string[];
}

export interface CveCandidate {
  cve: string | null;
  source: CveService;
  title: string;
  /** Confidence: exact-match (product+version+class) / likely / possible. */
  confidence: "exact-match" | "likely" | "possible";
  url: string;
}

/** NVD API 2.0 response (real shape — the fields the correlator reads). */
interface NvdResponse {
  totalResults?: number;
  vulnerabilities?: Array<{
    cve?: {
      id?: string;
      descriptions?: Array<{ lang?: string; value?: string }>;
    };
  }>;
}

/** OSV v1 response. */
interface OsvResponse {
  vulns?: Array<{
    id?: string;
    aliases?: string[];
    summary?: string;
    details?: string;
  }>;
}

/** GitHub Advisory REST response (list of advisory objects). */
interface GhsaResponse {
  id?: string;
  cve_id?: string | null;
  summary?: string;
}

/**
 * The production fetch: pinned DNS (resolve per call, connect by IP with
 * the correct SNI/Host), fixed-host URLs only, 15s timeout, JSON only.
 */
export function createPinnedJsonFetch(deps: CveServicesDeps = {}): JsonFetch {
  const resolver = deps.resolver;
  return async (url: string, init?: { method?: "GET" | "POST"; body?: string }): Promise<unknown> => {
    const u = new URL(url);
    const host = u.hostname;
    if (
      host !== CVE_SERVICE_HOSTS.nvd &&
      host !== CVE_SERVICE_HOSTS.osv &&
      host !== CVE_SERVICE_HOSTS.ghsa
    ) {
      throw new Error(`refusing non-CVE-service host ${host}`);
    }
    const ips = resolver !== undefined ? (await resolver.resolve(host, 443)).ips : null;
    const headers: Record<string, string> = {
      host: host,
      accept:
        host === CVE_SERVICE_HOSTS.ghsa ? "application/vnd.github+json" : "application/json",
      "user-agent": "nyx-cve-correlator/1",
    };
    const method = init?.method ?? "GET";
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    return new Promise<unknown>((resolve, reject) => {
      const req = httpsRequest(
        {
          host: ips !== null && ips.length > 0 ? ips[0]!.address : host,
          servername: host,
          port: 443,
          path: `${u.pathname}${u.search}`,
          method,
          headers,
          timeout: 15_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            try {
              resolve(JSON.parse(body) as unknown);
            } catch (err) {
              reject(new Error(`non-JSON response from ${host}: ${(err as Error).message}`));
            }
          });
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`CVE service ${host} timed out`));
      });
      req.on("error", reject);
      if (init?.body !== undefined) req.write(init.body);
      req.end();
    });
  };
}

/**
 * Query the services and score candidates. Confidence:
 *   exact-match — the product+version appears AND a vuln term matches
 *   likely      — the product appears, class does not match
 *   possible    — class-only or weak match
 * NVD + OSV discover; GHSA enriches each found CVE with its advisory
 * summary (and independently confirms the mapping).
 */
export async function queryCveServices(
  query: CveServiceQuery,
  fetchImpl: JsonFetch,
): Promise<{ candidates: CveCandidate[]; queries: string[] }> {
  const terms = (query.vuln_terms ?? []).map((t) => t.toLowerCase());
  const product = query.product.toLowerCase();
  const version = query.version?.toLowerCase();
  const candidates: CveCandidate[] = [];
  const queries: string[] = [];

  // 1. NVD 2.0 keyword search.
  const nvdQuery = [query.product, ...(query.vuln_terms ?? [])].join(" ");
  const nvdUrl =
    `https://${CVE_SERVICE_HOSTS.nvd}/rest/json/cves/2.0?keywordSearch=` +
    encodeURIComponent(nvdQuery);
  queries.push(nvdUrl);
  const nvd = (await fetchImpl(nvdUrl).catch(() => null)) as NvdResponse | null;
  if (nvd !== null && Array.isArray(nvd.vulnerabilities)) {
    for (const v of nvd.vulnerabilities) {
      const cveId = v.cve?.id;
      if (cveId === undefined) continue;
      const desc =
        v.cve?.descriptions?.find((d) => d.lang === "en")?.value ??
        v.cve?.descriptions?.[0]?.value ??
        "";
      candidates.push({
        cve: cveId,
        source: "nvd",
        title: desc.slice(0, 300),
        confidence: scoreCandidate(desc, product, version, terms),
        url: `https://nvd.nist.gov/vuln/detail/${cveId}`,
      });
    }
  }

  // 2. OSV v1 package query (POST).
  const osvUrl = `https://${CVE_SERVICE_HOSTS.osv}/v1/query`;
  const osvBody = JSON.stringify({
    package: { name: query.product },
    ...(query.version !== undefined ? { version: query.version } : {}),
  });
  queries.push(`${osvUrl} (POST ${osvBody})`);
  const osv = (await fetchImpl(osvUrl, { method: "POST", body: osvBody }).catch(() => null)) as
    | OsvResponse
    | null;
  if (osv !== null && Array.isArray(osv.vulns)) {
    for (const v of osv.vulns) {
      const cve = (v.aliases ?? []).find((a) => a.startsWith("CVE-")) ?? null;
      if (cve === null && v.id === undefined) continue;
      const text = `${v.summary ?? ""} ${v.details ?? ""}`;
      candidates.push({
        cve,
        source: "osv",
        title: (v.summary ?? v.id ?? "").slice(0, 300),
        confidence: scoreCandidate(text, product, version, terms),
        url:
          cve !== null
            ? `https://osv.dev/vulnerability/${cve}`
            : `https://osv.dev/vulnerability/${v.id ?? ""}`,
      });
    }
  }

  // 3. GHSA enrichment per unique CVE found.
  const seen = new Set(candidates.map((c) => c.cve).filter((c): c is string => c !== null));
  for (const cve of seen) {
    const ghsaUrl =
      `https://${CVE_SERVICE_HOSTS.ghsa}/advisories?cve_id=` + encodeURIComponent(cve);
    queries.push(ghsaUrl);
    const ghsa = (await fetchImpl(ghsaUrl).catch(() => null)) as
      | Array<GhsaResponse>
      | { items?: Array<GhsaResponse> }
      | null;
    const items = Array.isArray(ghsa)
      ? ghsa
      : ghsa !== null && Array.isArray((ghsa as { items?: Array<GhsaResponse> }).items)
        ? (ghsa as { items: Array<GhsaResponse> }).items
        : [];
    for (const a of items) {
      if (a.cve_id === null || a.cve_id === undefined || a.cve_id !== cve) continue;
      candidates.push({
        cve,
        source: "ghsa",
        title: (a.summary ?? "").slice(0, 300),
        confidence: scoreCandidate(a.summary ?? "", product, version, terms),
        url: `https://github.com/advisories/${a.id ?? cve}`,
      });
    }
  }

  // Rank: exact-match first, then likely, then possible.
  const rank = { "exact-match": 0, likely: 1, possible: 2 } as const;
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence]);
  return { candidates, queries };
}

function scoreCandidate(
  text: string,
  product: string,
  version: string | undefined,
  terms: string[],
): CveCandidate["confidence"] {
  const t = text.toLowerCase();
  // Token overlap instead of a literal substring: advisory prose varies
  // ("Apache httpd" vs "Apache HTTP Server") — significant product tokens
  // (len > 2) matched against the text.
  const tokens = product
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((tok) => tok.length > 2);
  const hit = tokens.filter((tok) => t.includes(tok)).length;
  const overlap = tokens.length === 0 ? 1 : hit / tokens.length;
  const versionHit = version !== undefined && t.includes(version);
  const termHit = terms.some((term) => t.includes(term));
  if (overlap >= 0.5 && versionHit && termHit) return "exact-match";
  if (overlap >= 0.5 || (versionHit && termHit)) return "likely";
  return "possible";
}
