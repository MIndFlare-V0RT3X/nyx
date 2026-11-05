---
name: security-sqlmap
description: SQL injection detection (benign scan) and authorized data extraction with sqlmap.
when_to_use: "Testing in-scope web parameters for SQL injection; extracting data only when the engagement declares the exploitation technique."
tools: ["security.sqlmap-scan", "security.sqlmap-exploit"]
persona_scope: ["security"]
attack_class: exploit
version: 1.0.0
---

# sqlmap — SQL injection detection and (authorized) extraction

**Detection:** `security.sqlmap-scan` with
`{ "url": "https://app.example.com/api/users?q=admin", "level": 1, "risk": 1 }`.
Benign by construction: `--batch`, no extraction flags. Detected injection
points become findings (severity high) with the console output as the
hash-verified evidence artifact. Rides the `vulnerability_scanning`
technique.

**Extraction:** `security.sqlmap-exploit` with
`{ "url": "...", "action": "dump", "table": "users" }` (also `dbs` /
`tables`). Requires the engagement's `exploitation` technique — the tool is
structurally absent without it. Extracted rows are returned as structured
data; the console output lands in the workspace as a hash-verified artifact.
Never auto-record extraction output as a finding — disclosure of extracted
data is the operator's call.

## Reading the output
Scan: `{ injectable, dbms, injection_points: [{ parameter, method, types: [{ type, title, payload }] }], total_requests, finding_id?, evidence }`.
Exploit: `{ action, tables: [{ database, table, entries, rows, raw }], evidence }`.
A clean `injectable: false` is a RESULT, not an error.

## Gotchas
- sqlmap has its own rate bucket (the example exploitation engagement sets
  2 rps) — and through the Phase 6.1 egress proxy every request is also
  charged the per-host default. Blocks, never drops.
- `level`/`risk` above default increase request volume sharply; justify it.
- Session state (`.sqlmap/`) lives in the workspace — it is scratch, not
  evidence; the evidence artifact is the captured console output.
