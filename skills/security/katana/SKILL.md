---
name: security-katana
description: Standard-mode web crawling that lists the endpoints reachable from in-scope URLs.
when_to_use: "Mapping an application's endpoint surface after confirming it is live."
tools: ["security.katana"]
persona_scope: ["security"]
attack_class: enum
version: 1.0.0
---

# katana — web crawling

Call `security.katana` with
`{ "targets": ["https://app.example.com/portal/"], "depth": 2 }` (depth 1–5,
default 2). Every target must be in the engagement's scope.

## Reading the output

`{ urls: string[], count }` — the crawled endpoint list.

## Gotchas

- Standard mode only: no headless browser, so JavaScript-rendered endpoints
  are invisible; say so when reporting coverage.
- Crawl results are inputs for `security-nuclei`, not findings themselves.
- Respect the rate limit: blocks, never drops.

## Preserving output

To keep a run as evidence, write the result into the workspace (`fs.write`
to `artifacts/katana-<target>.json`) and record its sha256 via `shell.exec`
(`sha256sum artifacts/katana-<target>.json`) — a finding you record later can then cite it
as hash-verified evidence.
