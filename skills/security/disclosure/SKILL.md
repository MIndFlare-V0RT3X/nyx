---
name: security-disclosure
description: The coordinated-disclosure workflow — correlate findings to CVEs, minimize PoCs, assemble disclosure packages, and prepare MITRE CVE requests.
when_to_use: "After a finding is confirmed: mapping it to known CVEs, reducing the reproduction to a minimum, or preparing vendor disclosure."
tools:
  [
    "security.correlate-cve",
    "security.minimize-poc",
    "security.prepare-disclosure",
    "security.submit-cve",
  ]
persona_scope: ["security"]
attack_class: scan
version: 1.0.0
---

# Disclosure — correlate, minimize, prepare, submit

The professional workflow, one tool per step. There is no "novel CVE
generator" here — a CVE is a human-reviewed registry entry; these tools
automate the automatable parts and keep the attestation human.

## 1. Correlate

`security.correlate-cve` with
`{ "finding_id": "...", "product": "Apache httpd", "version": "2.4.49", "vuln_terms": ["path traversal"] }`.
Queries NVD 2.0, OSV, and the GitHub Advisory Database (fixed research
hosts — never engagement targets; every query audit-logged). Confidence
tiers: `exact-match` / `likely` / `possible`; matched CVE ids are written
back to the finding. `no_match` is a result, not an error — it is the
signal to prepare a novel disclosure.

## 2. Minimize

`security.minimize-poc` with
`{ "finding_id": "...", "poc": "<raw HTTP request>", "required_tokens": ["/icons/../../../etc/passwd", "Host:"] }`.
Subset-only reduction: lines are DELETED, never modified — the output
cannot fabricate a PoC that was never tested. `cannot_minimize` means every
line is load-bearing; a reduction that would require modifying a line is a
fabrication and is refused. Re-verify the minimized PoC still reproduces
before disclosure.

## 3. Prepare

`security.prepare-disclosure` with
`{ "finding_id": "...", "affected_versions": ["2.4.49"], "vendor_contact": "security@vendor.example", "impact": "..." }`.
Writes `disclosures/<finding-id>/`: reproduction.md, impact.md, versions.md,
timeline.md (90-day coordinated disclosure, configurable), email.md (draft
vendor notification). Every file sha256-hashed; the manifest hash lands in
the audit chain.

## 4. Submit (R4 — the owner approves every call)

`security.submit-cve` with
`{ "finding_id": "...", "package_dir": "disclosures/<id>", "researcher_contact": "..." }`.
Produces the MITRE CVE request form content (CNA fields) from the prepared
package. **The tool never submits** — no network path exists; the operator
reviews `cve-request.md` and submits at cveform.mitre.org. A CVE request is
a signed attestation; automating it would undermine the registry.

## Gotchas

- Every step is scoped to THIS session's engagement — a finding from
  another engagement is refused.
- correlate-cve queries carry finding-derived terms to public databases —
  they are audit-logged (`security.cve.query`); keep product/version terms
  neutral (they are not engagement secrets, but the query log is reviewable).
- The disclosure package lives in the session workspace
  (`disclosures/<finding-id>/`); its evidence chain references the finding's
  hash-verified artifacts.
