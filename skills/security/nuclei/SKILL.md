---
name: security-nuclei
description: Template-based vulnerability scanning that records every match as an engagement finding with hash-verified evidence.
when_to_use: "Scanning live in-scope URLs for known vulnerabilities after probing/crawling."
tools: ["security.nuclei"]
persona_scope: ["security"]
attack_class: scan
version: 1.0.0
---

# nuclei — template-based vulnerability scanning

Call `security.nuclei` with
`{ "targets": ["https://app.example.com/portal/"], "templates": "cve,poc", "severity": ["critical", "high"] }`.
Requires the `vulnerability_scanning` technique in the engagement — without
it the tool is absent from your registry entirely.

## Reading the output
`{ artifact, sha256, findings: [{ id, title, severity, target }], count }`.
Every match is written to the findings database bound to this session's
engagement, with severity, CVSS (when the template classifies one), and the
run's raw JSONL output stored as the hash-recorded evidence artifact.

## Gotchas
- A template MATCH is not a confirmed vulnerability — verify before
  remediating; update finding status once confirmed or marked false positive.
- Findings can never carry a foreign engagement id — they inherit this
  session's binding structurally.
- Rate limits block rather than drop; large scans take time.
