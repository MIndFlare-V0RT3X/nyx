# Findings and Reports (Phase 5)

Findings are the durable product of an engagement: every one is bound to
its engagement, carries hash-verified evidence, and feeds a report that
structurally cannot claim out-of-scope testing.

## The Finding model

```
Finding {
  id, engagement_id, session_id          # ids derived from the session binding
  title, description
  severity: info | low | medium | high | critical
  cvss_3_1?, cvss_4_0?                   # computed from the template's vector
  cwe?[], cve?[]
  target: { host, port?, path? }
  evidence: [{ path, hash, mime }]       # workspace-relative, sha256-verified
  reproduction, remediation
  status: open | confirmed | false_positive | duplicate
  discovered_at, discovered_by           # e.g. "nuclei/security.nuclei"
  notes
}
```

## The store

Findings live in `nyx.db` (migration `0004_findings`), indexed by
(engagement, severity), target host, and status, with an FTS5 mirror over
title/description kept in sync by triggers. `search()` sanitizes queries to
AND-joined quoted tokens — FTS5 operators never reach MATCH syntax.

**The structural binding:** findings are written through
`createInSession(binding, finding)`, which derives `engagement_id` and
`session_id` from the runtime binding — a foreign engagement id in the
input is inert, and a session without an engagement cannot write findings
at all. The exported `create()` is the admin surface; no model-reachable
path uses it.

## CVSS

Both scorers are spec-faithful and tested against published vectors:

- **CVSS 3.1** (`cvss3.ts`): the specification formula — scope-dependent
  Privileges Required weights, ISS/Impact/Exploitability, the Roundup rule
  with a floating-point stabilization guard. Eight published vectors
  (9.8, 10.0, 8.8, 7.5, 6.1, 5.4, 9.1, 3.1) reproduce; the exhaustive
  2,592-combination differential against the official calculator shows
  zero differences.
- **CVSS 4.0** (`cvss4.ts` + `cvss4-data.ts`): a faithful port of the
  FIRST/RedHat reference — the MacroVector lookup (270 entries, generated
  verbatim and regenerable via `scripts/generate-cvss4-data.mjs`), the
  next-lower-macro interpolation, severity distances, EPSILON rounding.
  All nine FIRST Examples-document vectors reproduce exactly. (A fan-out
  reviewer's differential harness caught an eq3/eq6 branch error that
  inflated a macrovector family — fixed with a regression vector.)

nuclei computes both scores from a match's `cvss-metrics` when present; a
malformed vector in one match no longer aborts the remaining matches (the
finding lands unscored).

## Evidence

Hard rule #5: a finding without a hash-verified artifact is not a finding.
- nuclei records its raw JSONL output into the sandbox `artifacts/`
  directory and stamps the sha256 on every finding of the run.
- The other tools return result data; their SKILL.md files document the
  preserve-as-evidence recipe (`fs.write` to `artifacts/…` + `sha256sum`).
- At report time `verifyEvidence` re-reads every artifact from the
  engagement workspace, resolves symlinks (an in-workspace symlink pointing
  outside is an escape error), and re-verifies the sha256 against the
  recorded hash — tampered or missing artifacts abort the report.

## Reports

`generateReport` produces Markdown (bug-bounty paste) and self-contained
HTML (client-ready: one inline `<style>`, zero external fetches, every
finding-controlled string escaped) from one gated pipeline:

1. **Scope gate** — every finding's target is re-checked against the
   engagement at the finding's *discovery* time, which must lie inside the
   window. One out-of-scope finding → `OutOfScopeFindingError`, no file
   written. A port embedded in the host string faces the port policy; a
   path-bearing host rides the URL fallback only if hostname-shaped.
2. **Evidence gate** — every finding must HAVE evidence (an empty list is
   a vacuous pass and is refused) and every artifact must hash-verify.
3. **Render** — Executive Summary, Scope Statement (auto-populated from
   the engagement: id, client, window, authorized_by, emergency_contact,
   targets, exclusions, techniques — a report never claims more than the
   engagement authorized), Methodology, Findings (severity band → CVSS
   descending), Evidence, Remediation Summary, Appendix.
