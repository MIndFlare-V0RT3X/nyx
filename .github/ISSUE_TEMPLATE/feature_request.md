---
name: Feature request
about: A new capability, tool wrapper, channel, or behavior change
labels: enhancement
---

**The behavior you want**

What should the harness observably do? Behavioral evals assert on the
session event log — describe the desired event trajectory if you can
(`docs/EVALS.md` explains the format).

**Why it belongs in NYX**

NYX is the harness, not the model: capabilities are structural (tools,
policy, scope, memory), not prompts. Say where the capability sits.

**Out of scope / non-goals**

What this should NOT do (NYX is local-first, no telemetry, deny-first
policy; security tooling requires engagements).
