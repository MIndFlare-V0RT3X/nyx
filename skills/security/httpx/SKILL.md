---
name: security-httpx
description: Probe HTTP(S) targets for live services, status codes, titles, and technology fingerprints.
when_to_use: "After subdomain enumeration, or whenever you need to know which targets are live and what they run."
tools: ["security.httpx"]
persona_scope: ["security"]
attack_class: recon
version: 1.0.0
---

# httpx — HTTP probing

Call `security.httpx` with `{ "targets": ["https://app.example.com", "10.0.0.5"] }`
(hosts or absolute URLs, 1–100). Every target must be in the engagement's
scope; URL targets are matched structurally on scheme+host+path.

## Reading the output

`{ probes: [{ url, status, title, tech, web_server, content_type }], count }`.
Dead targets are ABSENT from the list — nothing answered to be probed.

## Gotchas

- The engagement's rate limit BLOCKS (never drops) — a big list just takes
  longer; do not retry "failed" probes that were merely slow.
- Live URLs are inputs to `security-nuclei` (scan) and `security-katana`
  (crawl). Record interesting observations as findings only with evidence.

## Preserving output

To keep a probe run as evidence, write the JSON result into the workspace
(`fs.write` to `artifacts/httpx-<target>.json`) and record its sha256 via
`shell.exec` (`sha256sum artifacts/httpx-<target>.json`) — a finding you
record later can then cite it as hash-verified evidence.
