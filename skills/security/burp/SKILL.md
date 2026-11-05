---
name: security-burp
description: Burp Suite integration — put the operator's Burp behind the engagement's egress gate and capture its history as hash-verified evidence.
when_to_use: "Manual web testing with Burp on authorized targets; importing the Burp history export as evidence."
tools: ["security.burp"]
persona_scope: ["security"]
attack_class: exploit
version: 1.0.0
---

# Burp Suite — manual testing behind the engagement's gate

Burp runs on the OPERATOR'S workstation (a GUI app; running it in a
headless container would need an X11 socket mount — the exact fd-leak
bypass the egress proxy forbids). NYX's integration makes the operator's
Burp a scoped client:

1. `security.burp` with `{ "action": "wiring" }` — returns the upstream
   proxy host:port for Burp's User options → Connections → Upstream Proxy
   Servers. Every request Burp makes then passes the engagement's egress
   proxy: scope-checked, rate-limited, audit-logged, exactly like sandbox
   traffic.
2. Test manually in Burp.
3. Export the history (Proxy → HTTP history → Save items, XML) into the
   session workspace, then `security.burp` with
   `{ "action": "capture", "file": "burp-export.xml" }`.

Capture output: `{ in_scope_count, out_of_scope_count, out_of_scope: [urls],
records: [...], artifact }` — in-scope entries become structured records
with a hash-verified artifact; OUT-OF-SCOPE entries are listed and excluded:
the capture cannot launder unauthorized traffic into evidence.

## Gotchas

- Requires an egress-proxied session (an engagement session with the Phase
  6.1 proxy enabled).
- Burp Community has no REST API (that is a Pro feature) — the wiring +
  XML export path is the honest integration surface.
