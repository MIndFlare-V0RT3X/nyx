# CVE Mapping + Disclosure Workflow (Phase 6.3)

The professional disclosure workflow, one tool per step:

```
finding → correlate-cve → minimize-poc → prepare-disclosure → submit-cve (R4)
```

There is no "novel CVE generator" here, because there is no such thing: a
CVE is a human-reviewed registry entry, not a tool output. What ships is the
workflow that gets a real finding successfully registered — the automatable
parts automated (correlation, minimization, package assembly, form content),
the human-judgment parts preserved as human steps (attestation, submission,
timeline negotiation).

## The tools

- **`security.correlate-cve`** — queries NVD 2.0 (keywordSearch), OSV v1
  (package query), and the GitHub Advisory Database (enrichment by cve_id,
  capped at 5) in the services' real documented shapes. The hosts are
  HARD-PINNED in code (`CVE_SERVICE_HOSTS`) — these are harness-level
  research endpoints, not engagement targets; the capability is
  `net.reference`, not `net.egress`. Every query is audit-logged
  (`security.cve.query`, written even when queries fail) and charges the
  engagement's `cve` rate class. Confidence is token-overlap based (with a
  small explicit synonym table — "httpd" ≡ "http server"):
  `exact-match` (product tokens + version + vuln class), `likely`, `possible`.
  Matched CVE ids MERGE into the finding's existing list; the correlated
  product persists on the finding. Service failures surface as
  `service_error` — never a silent `no_match`.

- **`security.minimize-poc`** — subset-only reduction: lines are DELETED,
  never modified, so the output is always a verbatim line-subsequence of the
  input — it cannot fabricate a PoC that was never tested. `Host:` is
  structural; the request line always survives; if any body line carries a
  token, the whole body block plus `Content-Length`/`Content-Type` survive as
  a unit (a body-less POST would be a fabricated non-repro).
  `cannot_minimize` means every line is load-bearing; a reduction that would
  require MODIFYING a line is refused. Re-verify the minimized PoC still
  reproduces before disclosure.

- **`security.prepare-disclosure`** — assembles `disclosures/<finding-id>/`:
  reproduction.md, impact.md, versions.md, timeline.md (90-day coordinated
  disclosure, configurable), email.md (draft vendor notification). Every file
  sha256-hashed; the manifest's hash is recorded on the FINDING ROW (the
  durable, model-unreachable record) and in the audit chain
  (`security.disclosure.prepared`). false_positive/duplicate findings are
  refused at the door.

- **`security.submit-cve`** — **R4: the owner approves every call** (the
  policy invariant asks regardless of config rules). Produces the MITRE CVE
  request form content (CNA fields) from a VERIFIED package: the manifest
  must bind to this finding, its hash must equal the hash recorded on the
  finding row, and every package file's content hash must match its manifest
  entry — anything else is refused ("modified after preparation"). The
  product in the form is the correlated product, never the engagement's
  target host. **No submission code path exists anywhere** — the operator
  reviews `cve-request.md` and submits at cveform.mitre.org by hand. A CVE
  request is an attestation to a vendor and to the registry; automating it
  would undermine the process.

## Why no auto-submit

Phase 6.3 could auto-submit. It should not. A CVE submission attests that
the operator has tested and confirmed a specific vulnerability in a specific
product. The tooling assembles the parts; the human attests. That is the
professional norm — every serious researcher writes the submission by hand
after the tooling has done the assembly.

## Residuals (owned, with target phases)

| Finding | Severity | Reason | Target Phase |
|---|---|---|---|
| Trusted plugins can unregister/re-register submit-cve at R1 (R3-14) | info | the registry API is a trusted-plugin surface; the R4 invariant itself is unbypassable | Phase 7 (plugin trust boundaries) |
| Pinned CVE fetch: single-address connect, no pagination, unauthenticated GHSA (R3-16) | info | fixed-host research traffic; NVD page 1 is the practical corpus for correlation | Phase 7 (research client hardening) |
