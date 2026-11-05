// SPDX-License-Identifier: AGPL-3.0-or-later
// The CVE service fixtures for the evals, keyed by HOST (the fixed service
// host list is the whole egress surface — see
// packages/security/src/skills/cve_services.ts). Shapes mirror the REAL
// NVD 2.0 / OSV / GHSA response bodies; CVE-2021-41773 (Apache httpd 2.4.49
// path traversal) is the brief's canonical acceptance case.

export interface CveFixture {
  nvd: () => unknown;
  osv: () => unknown;
  ghsa: () => unknown;
}

const NVD_HTTPD_41773 = () => ({
  resultsPerPage: 1,
  startIndex: 0,
  totalResults: 1,
  vulnerabilities: [
    {
      cve: {
        id: "CVE-2021-41773",
        descriptions: [
          {
            lang: "en",
            value:
              "A flaw was found in a change made to path normalization in Apache HTTP Server 2.4.49. " +
              "An attacker could use a path traversal attack to map URLs to files outside the expected document root.",
          },
        ],
        metrics: {
          cvssMetricV31: [
            {
              cvssData: {
                version: "3.1",
                vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N",
                baseScore: 7.5,
                baseSeverity: "HIGH",
              },
            },
          ],
        },
      },
    },
  ],
});

const NVD_EMPTY = () => ({
  resultsPerPage: 0,
  startIndex: 0,
  totalResults: 0,
  vulnerabilities: [],
});

const OSV_HTTPD = () => ({
  vulns: [
    {
      id: "GHSA-4gfj-5xv3-22t6",
      summary: "Path traversal and file disclosure in Apache HTTP Server 2.4.49",
      aliases: ["CVE-2021-41773"],
      affected: [
        {
          package: { ecosystem: "Apache", name: "httpd" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "2.4.49" }, { fixed: "2.4.51" }] }],
        },
      ],
    },
  ],
});

const OSV_EMPTY = () => ({ vulns: [] });

const GHSA_41773 = () => [
  {
    id: "GHSA-4gfj-5xv3-22t6",
    cve_id: "CVE-2021-41773",
    summary: "Path traversal and file disclosure in Apache HTTP Server",
    vulnerabilities: [],
  },
];

const GHSA_EMPTY = () => [];

/**
 * Fixture bodies by host. Every correlate-cve query hits the three fixed
 * hosts; the fixture answers regardless of the query string (the eval's
 * product is Apache httpd 2.4.49 — the exact-match path).
 */
export function CVE_FIXTURES_BY_HOST(host: string, _query: string): unknown {
  switch (host) {
    case "nvd.nist.gov":
      return NVD_HTTPD_41773();
    case "api.osv.dev":
      return OSV_HTTPD();
    case "api.github.com":
      return GHSA_41773();
    default:
      return NVD_EMPTY();
  }
}

export { NVD_EMPTY, OSV_EMPTY, GHSA_EMPTY };
