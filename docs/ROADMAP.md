# Roadmap

One phase at a time. Each phase lands on the seams the previous one reserved;
nothing here is built ahead of its turn.

| Phase | Scope (one line)                                                                                                                                                                              | Status      |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 0     | Foundation: protocol, kernel, session, model, scope, policy, sandbox, memory, persona, tools, agent, server, cli, web, e2e                                                                    | in progress |
| 1     | Channels: Telegram, Discord, Slack, email, generic webhooks; per-session lane queues; heartbeat/cron                                                                                          | planned     |
| 2     | Subagents: spawn, isolated context, summary-only return, delegation policy                                                                                                                    | planned     |
| 3     | Compaction pipeline: rule elision → session memory → LLM summary → emergency degrade                                                                                                          | planned     |
| 4     | Durable tasks: scheduler, SQL leases, pause/resume/retry, approval receipts via the `consume()` seam                                                                                          | planned     |
| 5     | Skills system: `SKILL.md` progressive disclosure, catalog, plugin SDK (the `SKILLS_CATALOG` section is already reserved)                                                                      | planned     |
| 6     | Authorized-engagement security tooling: recon, scanning, findings DB with CVSS, report generation — built on the scope engine; the tool-worker protocol seam is designed for a Python sidecar | planned     |
| 7     | Deeper RE / fuzzing / exploit dev for authorized engagements: fuzzing harness adapters, Ghidra headless, PoC generator, CVE mapping                                                           | planned     |
| 8     | More sandbox providers (E2B, Daytona) + a computer-use interface                                                                                                                              | planned     |
| 9     | Hardening, behavioral evals, release                                                                                                                                                          | planned     |

Phase 0 detail: the foundation packages `protocol`, `config`, `session`,
`model`, `scope`, `policy`, `sandbox`, `memory`, and `persona` (plus the
default persona and the example config) are implemented with test suites;
`kernel`, `tools`, `agent`, and the `server` / `cli` / `web` apps and e2e
suites are in flight against the frozen contracts. Seams already reserved for
later phases: `CompactionStrategy` (Phase 3), the `tasks` table in the session
DDL and `ApprovalEngine.consume()` (Phase 4), `SKILLS_CATALOG` (Phase 5), the
`Embedder` interface (vector retrieval), and sandbox `allowlist` networking
(implemented in Phase 6 — the egress proxy, docs/EGRESS-PROXY.md).

## Delivery status

Phases 0–3 and the Phase 4 build plan (durable tasks → retention → sandbox
forking + the artifact handoff → skills) are **delivered and tested** — see
`CHANGELOG.md` and `docs/TASKS.md`, `docs/RETENTION.md`, `docs/SKILLS.md`,
`docs/SUBAGENTS.md`. The notes below are the Phase-0 view of where the
seams are; where phase numbers differ, the build plan's numbering wins.

## Notes on later phases

Each later phase has a seam already in the repo — the point of the design is
that phases extend, not rewrite:

- **Phase 2 (subagents).** `SessionStore.fork(session_id, at_seq)` is already
  the context-isolation primitive: a subagent is a child session with an
  identical event prefix, and "summary-only return" is a policy on what the
  parent reads back.
- **Phase 4 (durable tasks).** The `tasks` table (with `lease_owner`,
  `lease_expires_at`, `attempts`) exists in the session DDL; lease claiming is
  one transaction. `ApprovalEngine.consume()` is the approval-receipt seam —
  it already enforces single-use, digest-bound consumption.
- **Phase 5 (skills).** `SKILLS_CATALOG` is section 6 of every assembled
  prompt today (empty by default); skills surface as one-liners with the body
  loaded on demand, exactly like memory.
- **Phase 6 (authorized-engagement tooling) — SHIPPED.** The egress proxy
  (docs/EGRESS-PROXY.md), the exploitation toolkit (docs/EXPLOITATION.md),
  and the CVE disclosure workflow (docs/DISCLOSURE.md), all on the Phase 5
  enforcement spine. New tooling registers as tool definitions — the
  `handler` locator scheme (`builtin:*`, `mcp:*`, `plugin:*`) is the surface
  a Python sidecar speaks without touching the kernel.
- **Phase 7 (host hardening).** The owned residuals from the Phase 6
  fan-out: the docker INPUT-path exposure (operator DOCKER-USER mitigation
  documented), a docker-capable CI lane for the acceptance suite, and plugin
  trust boundaries (docs/SECURITY-SUBSYSTEM.md residual table).
- **Phase 8 (more sandboxes).** `SandboxProviders` is a registry keyed by
  provider id; E2B and Daytona are new `SandboxProvider` implementations, not
  kernel changes.
- **Phase 9 (hardening).** The honest-limits list in
  `docs/SECURITY-MODEL.md` ("What Phase 0 does NOT defend against") is the
  hardening backlog, stated as such.

## Phase 1 needs first

- **A channel abstraction over the loop's event stream.** The loop already
  yields an ordered `SessionEvent` async iterable; a channel is a surface that
  feeds messages in and renders events out. No loop changes.
- **Per-session lane queues.** One in-flight turn per session; queued messages
  for the rest. The session store's `seq` ordering is the serialization
  point.
- **Fan-out.** The server's WS multiplexing (`/v1/ws`, subscribe/unsubscribe
  across sessions) already provides the primitive a multi-channel surface
  needs.

## Deliberately not building

- **Refusal-retry machinery.** No refusal detection, no retry-on-refusal, no
  persona-drift scoring. The model layer is provider-neutral and moves tokens;
  the persona contract binds voice, scope discipline, evidence, and honest
  boundaries — it does not strip or fight the model's judgment.
- **Telemetry, analytics, phone-home.** The only outbound calls are to the
  model providers the operator configured.
- **Hosted SaaS.** Local-first, self-hosted, single-operator by design.
- **Benchmark-chasing.** Behavioral evals and outcome verification come first
  (Phase 9); the harness is built for the operator, not for leaderboards.
