# Changelog

All notable changes to NYX are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
SemVer once 0.1.0 ships.

## [Unreleased]

### Added — Phase 0 (foundation)

- Monorepo scaffold: pnpm workspaces + Turborepo, strict TypeScript (ESM),
  ESLint with enforced package dependency direction, Prettier, GitHub Actions CI.
- `@nyx/protocol` — frozen shared contracts: session events (append-only,
  store-assigned `seq`), content blocks, model provider/streaming chunks, tool
  definitions and runtime context, policy/approval types, sandbox interface,
  memory store, engagement scope types, the four-hook surface, kernel plugin
  types, agent loop types, and Zod schemas for every type that crosses a
  process boundary.
- `@nyx/config` — Zod-validated `nyx.config.yaml` loader with `${VAR}` env
  interpolation, file/line/field error reporting, frozen typed output, and the
  single `BRAND` constant.
- `@nyx/kernel` — plugin loader with topological ordering, priority hook bus,
  service registry, and capability enforcement (undeclared access throws).
- `@nyx/session` — append-only SQLite event log (WAL), store-assigned monotonic
  `seq`, projections (messages / tool_calls / approvals / usage) with
  `projection_version` tracking, full replay, and fork-at-seq.
- `@nyx/model` — neutral provider registry (any OpenAI-compatible base URL,
  local/self-hosted first-class), OpenAI-compatible and Anthropic providers,
  deterministic mock provider, fallback-chain model router, and secret
  redaction. No refusal-detection or refusal-retry machinery by design.
- `@nyx/scope` — engagement scope engine: IPv4/IPv6 CIDR and domain-suffix
  target matching, exclusions, port policy, engagement expiry.
- `@nyx/policy` — deny-first rule engine (`deny > ask > allow`), immutable
  structural invariants, sha256 action digests (exact-action binding),
  single-use 10-minute approvals, hash-chained audit log with tamper detection.
- `@nyx/sandbox` — path-contained local sandbox (development only, refuses to
  run in production) and Docker sandbox provider (per-session container,
  network `none`, resource + wall-clock limits).
- `@nyx/tools` — registry, router, and runtime: Zod input validation,
  centralized path containment, policy evaluation, approval awaiting, scope
  enforcement for network tools, timeouts, 64 KB output truncation with
  artifact spillover. Builtins: `fs.read`, `fs.write`, `fs.list`,
  `shell.exec`, `web.fetch`.
- `@nyx/memory` — markdown-backed memory store with SQLite FTS5 index, tag
  boosting, and compaction (duplicate merge, episode expiry).
- `@nyx/persona` — persona directory loader and deterministic 8-section system
  prompt assembly; ships the default persona (Nyx) with an honest operator
  contract: evidence over claims, scope discipline, no refusal-stripping.
- `@nyx/agent` — the single dependency-injected agent loop with rule-based
  elision compaction, one-shot error recovery, and exact event sequencing.
- `@nyx/server` — Hono app: sessions, turns, SSE event stream with
  `Last-Event-ID` resume, fork, approvals (R4 owner-only), models, health,
  WebSocket multiplexing, bearer auth, loopback bind by default.
- `@nyx/cli` — `nyx` binary: init/run/chat (Ink TUI with streaming, tool
  transcript, approval modal), sessions, approvals, models, config validate,
  doctor.
- `@nyx/web` — minimal React client: session list, live streaming session
  view, tool cards, approval panel.
- End-to-end tests: smoke (tool-call turn), approval (allow/deny paths),
  replay (fork prefix identity), scope (out-of-scope egress denied).

### Security & hardening — Phase 0 verification round

A three-way parallel deep review (model layer, persona subsystem, security
subsystem) against the design guarantees, followed by targeted fixes:

- **Content-neutrality is now test-enforced.** Regression tests pin the
  transport-only invariant at both the router and the OpenAI-compatible
  transport: a refusal-shaped completion is streamed through verbatim with
  exactly one request, no retry, no fallback (`@nyx/model`).
- **Transport-only fallback allow-list at runtime.** `ModelRouterImpl`
  filters `fallback_on` through a `rate_limit | server_error | timeout`
  allow-list, so a programmatically constructed config cannot smuggle a
  content-derived error code into the fallback path even where the Zod enum
  on the config-file surface does not apply (`@nyx/model`).
- **Audit-chain verification runs at load, not only in tests.**
  `openApprovalEngine` verifies the hash chain when opening the approvals
  database and refuses to start on a broken chain (typed
  `validation_failed`), covering `nyx run`, `nyx chat`, `nyx approvals`,
  and the server (`@nyx/policy`).
- **Egress port-policy bypass closed.** Host-field egress inputs now parse
  inline `host:port` and `[v6]:port` authority forms and reject conflicting
  port declarations, so engagement port allow/deny lists are actually
  checked on the host-field path (`@nyx/tools`).
- **Persona honesty fixes.** `personas/default/MEMORY.md` no longer claims
  automatic memory appends (the feature is deferred); the assembled
  system prompt is now regression-tested to carry the contract's
  scope-discipline, honesty, verification, and escalation clauses; a
  nonexistent persona directory fails validation naming the path
  (`@nyx/persona`).
- **Type debt cleared.** All 16 workspace packages typecheck clean
  (`tsc --noEmit`), including test files.
- **Docs.** `SECURITY-MODEL.md` credential section now states keys are read
  at startup (provider construction), matching the implementation.

Verification status after this round: 29/29 test tasks green — 676 tests
passed, 8 Docker-sandbox tests conditionally skipped (no Docker daemon);
`pnpm build` 15/15; CLI smoke-tested end to end (`init`, `run` with valid /
expired / malformed engagements, `doctor`).
