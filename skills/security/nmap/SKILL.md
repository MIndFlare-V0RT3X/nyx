---
name: security-nmap
description: Port scanning (connect scan, service detection) of in-scope hosts or CIDR blocks, packet-rate limited.
when_to_use: "Determining the exposed service surface of an authorized host or CIDR range."
tools: ["security.nmap"]
persona_scope: ["security"]
attack_class: scan
version: 1.0.0
---

# nmap — port scanning

Call `security.nmap` with
`{ "target": "203.0.113.0/24", "ports": "80,443" }` (host or CIDR; ports
optional, default top 1000). Requires the `port_scanning` technique.

## Scope rules for CIDR targets
A CIDR target must be COVERED by an authorized CIDR (same family, shorter or
equal prefix) and must not overlap ANY exclusion — the containment is
structural, checked before the scan fires. Scanning an unauthorized range is
denied with the reason.

## Reading the output
`{ target, open_ports: [{ host, port, service }], count }`.

## Gotchas
- Connect scans (-sT) only: no raw sockets, no OS fingerprinting, no NSE
  scripts — those are out of Phase 5's scope by design.
- The engagement's nmap bucket counts PACKETS per second and blocks, never
  drops; `--max-rate` is passed to the binary cooperatively as well.
