---
name: security-subfinder
description: Passive subdomain enumeration for an in-scope domain via certificate transparency and passive DNS sources.
when_to_use: "Starting reconnaissance on a domain — enumerate subdomains before probing."
tools: ["security.subfinder"]
persona_scope: ["security"]
attack_class: recon
version: 1.0.0
---

# subfinder — passive subdomain enumeration

Call the `security.subfinder` tool with `{ "domain": "example.com" }`. The
domain must be inside the engagement's scope (suffix-anchored); out-of-scope
domains are denied before the tool fires.

## Reading the output
The tool returns `{ domain, subdomains: string[], count }`. Subdomains are
deduplicated and lowercased.

## Gotchas
- Passive sources only — no packets touch the target domain itself.
- API-key sources need the operator's provider config; the public sources
  still work without keys.
- Feed the list to `security-httpx` (probe) or `security-katana` (crawl);
  subdomains alone are not findings.
- Wildcard engagements (`*.example.com`) authorize strict subdomains only —
  the apex needs its own entry.
