# Changelog

All notable changes to NYX are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
SemVer once 0.1.0 ships.

## [Unreleased]

### Added — Phase 2 (unified DB, channel approvals, compaction)

**2.0 Carryover gate** (the four items the Phase 1 review flagged):

- **Unified database (2.0.1).** One `nyx.db` (WAL, `synchronous=FULL`,
  `busy_timeout=5000`) owns every table: the event log and projections, the
  approval engine (`policy_approvals`) and the hash-chained audit, channel
  session mappings, heartbeat state. New package `@nyx/db`:
  `openUnifiedDatabase` migrates the Phase 0/1 split layout (policy.db /
  channels.db / heartbeat.db) in ONE transaction — audit rows copied with
  `id`, `prev_hash` linkage, and every column (incl. `event_seq`); chain
  verified in-transaction before commit (head must match, whole chain must
  re-verify) or the migration aborts with originals intact; legacy files
  renamed `<name>.migrated-<ts>`, never deleted; a `db.migrated` row is
  chained onto the previous head. **Transactionality is now structural:**
  the session store's `onEventsCommitted` hook writes audit rows inside the
  append's own transaction — a crash between event and audit writes leaves
  neither row (TDD: red atomicity test first). Concurrency: 4 workers × 25
  appends land 100 events + 100 audit rows with a valid chain. e2e: a
  Phase-1 data dir migrates on server open and turns keep working.
- **Per-session abort route (2.0.2).** `DELETE /v1/sessions/:id/turns`
  aborts the running turn and clears that session's queued turns only,
  returning `{aborted_running, cleared_queued}`; pending approvals are
  withdrawn (deny, `system:withdrawn`, audited — no orphans); the aborted
  turn ends `turn.failed` reason `aborted` (new round-top abort check in the
  loop); other sessions unaffected; the lane stays usable.
- **Heartbeat timezone (2.0.3).** `HeartbeatSpec.timezone` (IANA, default
  UTC); `nextFire` interprets cron in the spec's zone via `Intl.DateTimeFormat`
  (full ICU). DST gaps skip (vixie-cron); fall-back ambiguity fires once
  (first occurrence). Tested: PKT offset, New York spring-forward (no skip,
  no double), 02:30 gap skip, fall-back single-fire, UTC-default unchanged.
- **Engagement-creation audit (2.0.4).** Every engagement binding writes an
  `engagement.created` row; domain-only engagements record the initial DNS
  resolution (post-hoc validation of what the pin trusts); CIDR-constrained
  ones record the constraint; resolution failures recorded, never thrown.
  `nyx doctor` warns on active domain-only engagements and reports the
  database unified/pending-migration state.

**2.1 Channel approvals** — an `ask` verdict on a channel surface is
interactive instead of a TTL death:

- `ApprovalPresenter` (`present`/`withdraw`) + `ApprovalRequest` in
  `@nyx/policy`; `registerPresenter`/`unregisterPresenter` on the engine
  (the frozen protocol interface is untouched). Channel TTL 5 minutes
  (TTY stays 10); `channels.<id>.approval_ttl_ms` overrides. `present()`
  failure never breaks a turn; expiry auto-denies AND withdraws; abort and
  session teardown withdraw (no orphans).
- Telegram: inline keyboard `[✅ Allow] [❌ Deny]`; `callback_query` routed
  through `TelegramApprovalBridge` (allowed_user_ids gate → engine.resolve →
  answer + keyboard edit); expiry message "⏱ approval expired — action
  denied"; a text message during a pending approval is NOT a decision (it
  queues as a normal turn).
- Webhook: the pending HTTP POST returns `approval_required` with
  `resolve_url`; the client resolves via `POST /v1/approvals/:id/resolve`
  (alias of the resolve route: same auth, same R4 owner gate).
  Presentations buffered per session (no arrival-order race).

**2.2 Compaction pipeline** — the four tiers the ROADMAP promised
(`packages/agent/src/compaction-pipeline.ts`, kernel service
`agent.compaction`, config `context.compaction`):

- Tier 1 elision (Phase 0's strategy promoted), Tier 2 session memory
  (cheap low-effort summary of everything before the last 5 completed turns,
  written to `@nyx/memory` scope `session`, restart-safe), Tier 3 LLM
  summary (K=10 before the current ask; decisions/state/open-questions
  shape; the current ask is never summarized away), Tier 4 emergency
  (still > 95% after 1–3: drop the oldest half, keep the last 10, persona
  preamble survives, operator warning, hash-chained audit row).
- Post-compaction re-read: up to 5 recently-edited files re-read into
  context capped at 5000 tokens (mid-edit continuity).
- Compaction never loses events — only the model-facing list changes;
  recovery is `session.read()`. Golden-file tests for tiers 1/3/4; e2e
  large-session smoke; small sessions no-op.

Phase 2 test total: **816 passing, 0 failing** (Phase 1: 744), typecheck
clean, lint clean, build 16/16 packages.


### Added — Phase 1 (hardening, lanes, channels, heartbeat)

**1.0 Hardening** (the four items the Phase 0 review flagged):

- **DNS-rebinding defense.** `web.fetch` authorizes egress at connection time
  on the *resolved* addresses: a pinned `EgressResolver` + `checkResolvedTarget`
  (hostname must pass the domain check AND, when the engagement declares CIDRs,
  every resolved IP must fall inside them), a `node:http(s)` transport pinned
  to the validated address via a `lookup` override (DNS is never consulted
  again), per-hop re-resolution on redirects, trailing-dot normalization, and
  a TTL pin. Deny reason: `dns_rebinding_out_of_scope`. Domain-only
  engagements keep hostname-only authorization (documented residual).
- **Tool executions in the hash-chained audit log.** `tool.call` /
  `tool.result` / `tool.error` / `action.denied` events audit with an
  `event_seq` cross-reference (back-compatible hashing; in-place migration),
  written by both apps' EventSinks; `reconcileEventAudit` cross-checks chain
  against event log; 1,000-event interleaved verification tested.
- **Engagement `operator_id` ↔ owner binding.** `assertEngagementOwnership`
  in `@nyx/policy` (every entry point: CLI + server session creation);
  mismatch is a hard `engagement_ownership` error naming both ids.
- **First-run USER.md bootstrap.** `nyx init` prompts for name, timezone, and
  standing instructions and writes the default persona's USER.md; skips
  already-populated files; `nyx init --yes` writes the template unchanged;
  repo checkouts copy the full default persona to the fresh home.

**1.1 Lane queue** — new `@nyx/runtime`: per-session FIFO lanes, serial
execution by default, global concurrency cap with round-robin fairness, abort
propagation (aborting a running task cancels it and drains that session's
queue; other sessions untouched), heartbeat-parallel opt-out. The server's
`POST /v1/sessions/:id/turns` enqueues and returns `turn_id` + lane status
immediately — a second turn while one is in flight **queues instead of
409ing**. Verified with a 100-turn FIFO test via event seq monotonicity.

**1.2 Channels** — new `@nyx/channels`: `ChannelAdapter` interface, webhook
adapter (loopback HTTP listener; reply delivered exactly once in the response;
202 with ids past `reply_timeout_ms`), Telegram adapter (long-polling Bot API
via an injectable client — no network in CI; streaming replies via throttled
`editMessageText`; env-indirect bot token), and the manager that owns identity
allow lists (rejections audited, no reply), sha256(channel:user:thread) →
session mapping (persisted), and `/new` + `/fork`. Channels drive the same
lane/loop/policy/approval machinery as the HTTP API — no parallel policy
path. Config `channels` section, disabled by default.

**1.3 Heartbeat** — `@nyx/runtime` cron (hand-rolled 5-field parser, vixie
dom/dow semantics, UTC — declared choice, no new dependency) +
`HeartbeatScheduler` with SQLite-persisted state: fires enqueue
heartbeat-priority turns; state advances before firing (crash-safe); missed
fires (process down) are logged as `heartbeat.missed` and never re-fired;
manual `trigger()` does not consume the schedule. Server wiring with
`config.heartbeat` (disabled by default); recommended default specs
(memory-review daily 03:00, session-summary hourly) shipped commented.

**Docs:** `CHANNELS.md`, `HEARTBEAT.md` added; `ARCHITECTURE.md` (14-package
graph), `SECURITY-MODEL.md` (DNS-rebinding, tool audit, engagement
ownership, updated residuals) updated; example config documents `lanes`,
`channels`, `heartbeat`.

Verification: 33/33 test tasks — **744 passed, 0 failed**, 8 Docker-sandbox
skips; all 18 packages typecheck clean; lint clean; Phase 0 verification
items (replay-10k, approval-lifecycle, redaction grep) still pass.

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
