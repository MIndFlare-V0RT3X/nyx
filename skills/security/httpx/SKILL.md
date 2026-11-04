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
A probe with `status: null` means the target did not answer.

## Gotchas
- The engagement's rate limit BLOCKS (never drops) — a big list just takes
  longer; do not retry "failed" probes that were merely slow.
- Live URLs are inputs to `security-nuclei` (scan) and `security-katana`
  (crawl). Record interesting observations as findings only with evidence.
