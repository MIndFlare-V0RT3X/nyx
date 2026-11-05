---
name: security-msf
description: Metasploit module search, inspection, and single-module runs against authorized targets.
when_to_use: "Finding the right Metasploit module for a confirmed issue, or running one module against an in-scope target when the engagement declares exploitation."
tools: ["security.msf-search", "security.msf-run"]
persona_scope: ["security"]
attack_class: exploit
version: 1.0.0
---

# Metasploit — module search, inspection, single-module runs

**Search/inspect (local, no target traffic):**
`security.msf-search` with `{ "command": "search", "query": "php cgi" }` or
`{ "command": "info", "module": "exploit/multi/http/php_cgi_arg_injection" }`.
Search returns `{ modules: [{ name, disclosure_date, rank, check, description }] }`;
info returns the module's formatted documentation.

**Run (R4 — the operator approves every run):**
`security.msf-run` with
`{ "module": "auxiliary/scanner/http/dir_scanner", "rhosts": "app.example.com", "options": { "RPORT": "8443" } }`.
RHOSTS is scope-checked before the console starts; options are
charset-guarded; exactly ONE module per call — no auxiliary-to-exploit
chains. Requires the `exploitation` technique.

## Gotchas

- The wrapper drives `msfconsole -q -x "..."` (batch mode) — see
  docs/EXPLOITATION.md for why the RPC daemon is not used.
- `rhosts` must be in engagement scope; an out-of-scope target denies before
  msfconsole ever launches.
- msfconsole startup is slow (the module DB loads per call) — prefer
  `msf-search` to plan, `msf-run` to execute.
