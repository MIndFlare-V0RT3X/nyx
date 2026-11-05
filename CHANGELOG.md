# Changelog

All notable changes to NYX are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
SemVer once 0.1.0 ships.

## [Unreleased]

### Added — Phase 5 (security subsystem: engagements · scope engine · findings · reports · security skills)

- **`@nyx/security` (new package)** — the security subsystem for authorized
  engagements. Engagement files (YAML/JSON, hash-pinned, immutable per
  session) with window/targets/exclusions/rate-limits/techniques; the
  three-layer scope engine (technique registry filter, checked egress path,
  action-time audit-row checks); the token-bucket rate limiter (per class +
  shared per-host default, blocks never drops); the findings DB in `nyx.db`
  (migration `0004_findings`, FTS5, structural session binding); CVSS 3.1 +
  4.0 scoring (spec-faithful ports, published-vector tested); the report
  generator (Markdown + self-contained HTML) with the out-of-scope and
  evidence gates; and the six tool wrappers (subfinder, httpx, nuclei, ffuf,
  katana, nmap) with charset-guarded argv and injectable executors.
- **`@nyx/scope`** — wildcard domains (strict subdomains), URL targets
  (structural scheme+host+path, segment-boundary subtrees), the window-start
  denial (`engagement_not_yet_active`), IP-literal URL entries, and
  `parseUrlTarget` exported. All additive; the Phase 1 semantics unchanged
  (matcher tests written first, watched red).
- **`@nyx/protocol`** — `Engagement` gains `starts_at`, `techniques`,
  `rate_limits`, `client`/`authorized_by`/`emergency_contact`; targets gain
  `urls`; the query gains `url`. All optional (zod mirrors extended).
- **`@nyx/tools`** — the `net.egress` pre-check understands the security
  input shapes (`targets[]`, `domain`, `target` incl. CIDR bases) and checks
  every entry; `security.ffuf`'s wordlist joined the contained path fields;
  the egress resolver types are exported.
- **`@nyx/skills`** — frontmatter gains `attack_class`
  (recon/enum/scan/exploit; Phase 5 ships the first three).
- **Shipped data** — `engagements/example.yaml` (RFC 5737/2606 targets
  only, no exploitation technique), `skills/security/` (six SKILL.md
  files), `personas/security/`, `Dockerfile.security` (fully pinned:
  subfinder v2.17.0, httpx v1.12.0, nuclei v3.11.1, ffuf v2.3.0, katana
  v1.8.0, nmap 7.93; fails the build on version mismatch),
  `scripts/generate-cvss4-data.mjs` (regenerates the CVSS 4.0 tables from
  the FIRST reference).
- **Config** — the `security:` section (`enabled`, `executor:
  sandbox|host`); both apps register the tools when enabled (safe by
  construction — unauthorized techniques are absent from the session's
  registry view) with the audit sink and one process-level limiter. The
  CLI's `--engagement` now loads YAML engagement files.
- **Docs** — `SECURITY-SUBSYSTEM.md`, `ENGAGEMENT.md`, `FINDINGS.md` (new);
  ARCHITECTURE (19 packages), SECURITY-MODEL (Phase 5 residuals), README
  (engagements quickstart, Dockerfile build, roadmap), example config.

### Fixed — Phase 5 hardening (the three-reviewer fan-out: 38 findings, all HIGH/MEDIUM fixed with regression tests)

- **R1** (scope bypass hunt, 11 findings): ffuf wordlist traversal closed
  at two layers (schema + runtime path containment — a model-reachable
  host-file read primitive); the engagement window re-checked after rate
  sleeps with binary runtimes capped to the window; rate buckets keyed by
  the normalized host (trailing-dot variants cannot split them); the tasks
  path builds subagent contexts over the engagement tooling; sandbox
  executor tokens single-quoted and the charset admits URL syntax; IPv6
  literals reach the resolver unbracketed; nmap refuses host-bits-set
  CIDRs; report window semantics corrected (per-finding discovery time —
  post-window report generation works).
- **R2** (findings/report integrity, 11 findings): a CVSS 4.0 eq3/eq6
  branch error that inflated a macrovector family (145,855 vectors, 20,212
  band flips per the reviewer's differential) fixed with a regression
  vector; empty-evidence findings refused (hard rule #5); ports embedded in
  host strings face the port policy; the URL fallback refuses hostile host
  shapes; duplicate ids render their own evidence; symlink escapes
  blocked via realpath; malformed CVSS in one nuclei match no longer aborts
  the batch; FTS asserted across restart.
- **R3** (skill wrapper correctness, 16 findings — the wrappers would not
  have worked against the real binaries): httpx/nuclei/katana targets now
  ride `-u` flags (goflags drops positionals); the nuclei parser reads the
  real dashed-key format with array ids; the nmap parser reads the real
  single-line greppable format; ffuf uses `-json` JSONL (the `-o
  /dev/stdout` form was polluted by quiet-mode prints) and normalizes
  dotted extensions; Dockerfile.security's three build breakers fixed
  (unzip, mv paths, the Debian nmap pin); nmap derives a conservative
  `--max-rate`; SKILL.md accuracy + evidence-preservation recipes.

### Added — Phase 4 (durable tasks · retention · sandbox forking · skills)

- **`@nyx/tasks` (new package).** Durable tasks: long-running work that
  survives restart, pauses/resumes, retries with exponential backoff
  (base × 4^(n−1)), recurs on cron (reset to pending at the NEXT fire —
  never double-fired inside a window), and executes as a subagent of the
  TASK's own session so its context never pollutes the parent's window.
  **SQL leases** are the only cross-process coordination: a claim is one
  conditional `UPDATE` (TTL 5 min, renewal 30 s, `renew < ttl` validated at
  config load AND pool construction); an expired lease is reclaimable by any
  worker and the reclaim consumes the crashed owner's attempt, so poison
  tasks converge to `failed` at `max_attempts` instead of looping forever.
  The full state machine is enforced by the `WHERE` clauses themselves
  (illegal transitions throw, never silently coerce); the worker pool (2 per
  process) releases — not clears — leases on graceful shutdown so another
  process reclaims immediately. Surfaces: `POST/GET /v1/tasks`,
  `pause/resume/retry`, `DELETE` (cancel), and `nyx tasks …` from another
  process (cross-process abort rows, the `nyx subagents abort` pattern).
  §6.1 three-way fan-out hardened the lease machinery: claim due-ness guard
  (R2-1), attempts-on-reclaim (R2-5), renew try/catch (R1-2/R3-1),
  synchronous running-attempt registration + both-directions release on
  stop() (R3-2), atomic transition columns (R2-3/R2-4/R3-3), cron re-anchor
  on retry() (R2-6 — found and fixed a live `recordOf` ReferenceError),
  `renew < ttl` validation (R1-5), settleRunning never fake-succeeds a lost
  row (R2-2).
- **Retention (archive-not-delete), as a durable task.** The
  `nyx:retention-gc` system task (daily 03:30 UTC cron, **ships disabled** —
  `subagents.retention_enabled` opts in; the surface only ENSURES the task
  exists at boot: create when absent, revive failed/cancelled, leave
  healthy/paused alone — never a startup sweep). A session past its window
  has its event rows MOVED to the sibling `nyx-archive.db` (ATTACHed on the
  same connection; idempotent copy-before-delete, so a crash anywhere is
  safely re-runnable and never loses an event) and its row marked
  `archived=1`/`archived_at`; `session.read()` serves the events from the
  archive; appends/forks on archived sessions are refused (a log never
  splits across databases). Scope `subagent`/`subagent+failed`/`all`/`none`
  with live-work protection: sessions tied to pending/running/paused tasks
  (own session, current attempt child, bound parent) are NEVER archived;
  failed ties are kept unless the scope includes failed. Hard deletion is a
  separate opt-in (`delete_after_days`, default off, archived rows only).
  Every pass that moves or deletes anything appends a hash-chained
  `retention.archived`/`retention.deleted` audit row with counts.
- **Sandbox forking (the new default).** `subagents.sandbox_sharing` flips
  `inherit → fork`: every child gets a FILESYSTEM COPY of the parent's
  sandbox (local: `cp -a`; docker: `commit` → temp image → run + host copy,
  temp image removed by id at destroy) — no shared mounts, no live handles,
  and a non-forkable sandbox in fork mode is refused LOUDLY (`not_supported`),
  never a silent fallback to sharing. **Artifacts are the only handoff**:
  the child-side `subagent_artifact` tool publishes into its sandbox's
  `artifacts/` (sha256 computed at the write source, hash-chained audit
  row), the parent-side `subagent_read_artifact` copies into the parent's
  sandbox only after re-hashing and matching the audited hash;
  `SubagentResult.artifacts` lists what was published. §6.2 two-way fan-out
  hardened it: LRU reap never destroys a RUNNING child's sandbox (R4-1),
  fork/artifacts-dir failures destroy the fork + roll the budget back
  (R4-2/4), docker forks stop leaking dangling images (R4-3) and mirror
  `--memory/--cpus` (R4-5), docker readFile refuses truncated captures
  (R5-2 — the audited handoff silently corrupted on >750KB files),
  cross-session artifact reads are parentage-refused (R5-1), 64MB artifact
  cap (R5-3), SQL-side + indexed hash lookup (R5-4), reader-attributed
  audit-before-write (R5-5/10), full-id default dest (R5-6), printable
  name charset (R5-8), terminal-mirror failure finalization (R4-6), local
  cp cleanup + wall clock (R4-7), copy-before-run (R4-10), the read tool
  structurally absent from CHILD allowlists (R5-11).
- **`@nyx/skills` (new package).** Progressive disclosure: SKILL.md
  (Zod-validated frontmatter: name/description/when_to_use/tools/
  persona_scope/version + Markdown body) scanned from `skills.dirs` and the
  persona's own `skills/` dir; the catalog rides the system prompt's
  `SKILLS_CATALOG` section via a `context.initialize` hook (persona-scoped,
  filtered by the session's REAL capabilities — a skill needing `net.egress`
  is not advertised to a session without an engagement — and curated under
  `catalog_max_tokens` with pinned + recency; overflow warns and names the
  drops); bodies load on demand through the R0 `load_skill` tool
  (`skill.loaded` on the session log; `already_loaded`/`scope_mismatch`
  refusals). Skills are trusted CONTENT, not tools: loading grants nothing;
  the frontmatter `tools` field is informational (runtime gating is Phase 5).
  Golden-file prompt test covers the exact assembled catalog.
- **Protocol (recorded deviations, brief-mandated).** `SubagentResult.
  artifacts` (path+bytes, optional for pre-Phase-4 results) and the
  `skill.loaded` session event; `SECTION_ORDER`'s `SKILLS_CATALOG` and
  `PromptAssemblyInput.skills_catalog` were already staged.
- **Docs.** `docs/TASKS.md`, `docs/RETENTION.md`, `docs/SKILLS.md` (new);
  `docs/SUBAGENTS.md` rewritten for fork mode + the artifact handoff;
  ARCHITECTURE (17-package graph), README, SECURITY-MODEL, and the example
  config updated.

### Added — Phase 3 (subagents)

- **`@nyx/subagents` (new package).** The subagent system: a child session
  (`kind="subagent"`, `parent_id` lineage) with its own context window, a
  narrowed tool registry, an isolated memory view, and the parent's sandbox.
  `SubagentManager.spawn` checks depth (`max_depth`, default 3; 0 = no
  spawning at all; a spec's `max_depth_override` may only tighten) and the
  per-turn budget (allocation-based: `min(spec ?? default, max_budget)` per
  child, summed per parent turn against `max_total_per_turn`) BEFORE the
  child exists, then runs `AgentLoop.run` with the task framed as the initial
  user message. Only the final summary crosses back — as the `spawn_subagent`
  tool result JSON. `list()` reconstructs children from the event log
  (restart-safe); `abort()` covers in-process (direct controller) and
  cross-process (`subagent_abort_requests` rows on nyx.db, drained on a
  150 ms poll — the approval engine's pattern) paths.
- **Structural isolation (hard rules).** A subagent's tool registry is a
  `FilteredToolRegistry` view: `spawn_subagent` is absent BY CONSTRUCTION
  (independent of config; an attempted call is a clean `tool_unknown`), config
  `forbidden_tools` never pass, and the spec's allowlist is intersected with
  the parent registry (naming tools the parent lacks grants nothing). The
  child's TOOL RUNTIME is built over the filtered registry — enforcement sits
  on the execution path, not just the model-facing catalog. The child's
  memory is a `SubagentMemory` view: `session`-scope writes map onto the
  `subagent` scope keyed by the child's id; reads see only its own entries
  plus `global`; `get()` ownership-filters; `compact()` is a no-op. Child
  events never enter the parent's log — the four `subagent.*` lifecycle
  events are mirrored on BOTH logs (the parent's copy carries
  `subagent_session_id`). Budget crossing aborts the child
  (`state="budget_exceeded"`); the parent's signal aborts children
  (`subagent.aborted` on both logs) — abort propagation is not optional and
  is tested on all three paths.
- **`spawn_subagent` tool (risk R1, `concurrency: "parallel"`).** Registered
  on the registry at kernel setup — structurally absent when `max_depth` is
  0. The handler resolves its parent through the manager's per-turn
  `RunContext` binding (`bindTurn`/`unbindTurn` bracket every turn on every
  surface; the lane queue guarantees one live turn per session). Model-facing
  input: `{task, tools?, budget_tokens?}`.
- **Parallel rounds in the agent loop.** A model round whose calls are ALL
  `concurrency: "parallel"` dispatches concurrently with incremental event
  flushing; tool results reassemble in call order. Any serial-classified
  call keeps the round sequential (two `shell.exec` never overlap).
  Regression-tested (overlap proven by timing; order by index).
- **Schema migration `0001_sessions_kind`.** `sessions.kind TEXT NOT NULL
  DEFAULT 'session' CHECK (kind IN ('session','fork','subagent'))` +
  `archived_at`: existing rows become `'session'`, new forks are `'fork'`,
  subagent children are `'subagent'`. `list()` filters by kinds and hides
  archived sessions; `archiveSession()` marks (never deletes) — the id stays
  resolvable, the log replayable (hard rule #6).
- **Server.** Manager wired on kernel setup; a parent session's approval
  presenter is copied onto its children (`ApprovalEngine.presenterFor`, new)
  so an `ask` inside a child turn stays interactive. Routes:
  `GET /v1/sessions` excludes subagents unless `?include_subagents=true`;
  `GET /v1/sessions/:id/subagents`; `DELETE /v1/subagents/:id` (owner-only
  abort); `DELETE /v1/sessions/:id` (abort + archive, subagent sessions
  only). A child's SSE stream is the same `/v1/sessions/:id/events` handler.
- **CLI.** `nyx subagents list <parent>` / `nyx subagents abort <child>`
  (cross-process via nyx.db); `nyx sessions list --all` shows subagents with
  a `↳` prefix and parent; `nyx sessions show` prints the subagent lineage
  hint; the chat TUI renders the spawn card as `↳ subagent <task>`.
- **Compaction interaction.** A subagent summary counts against the parent's
  context budget like any tool output (Tier-1 elision applies); the child's
  full session is never in the parent's context. Inside the child, the
  four-tier pipeline runs over the isolated memory view — Tier-2 session
  memory lands in the `subagent` scope.
- **Fan-out validation (§5.1).** `tests/e2e/fanout-review.test.ts`: three
  reviewer subagents spawned in ONE round over the real Phase 3 sources
  (copied into their sandbox), restricted to `fs.read` + `grep` (no writes),
  running in parallel (proven by overlapping event windows) and returning
  findings. The reviewer models are scripted (NYX has no bundled LLM): the
  reads/greps are real, the findings are Fizz-authored from reviewing the
  same files — provenance documented in `docs/SUBAGENTS.md`. 14 findings:
  4 fixed this phase (running-entry leak on early throw; abort-reason
  tracking; allocation-race regression test; provider-signal contract
  documented), 10 verified-by-test or accepted-with-reason.
- **e2e.** Two subagents in one round run in parallel (the quick child
  starts and finishes inside the slow child's window — impossible under
  sequential dispatch), both summaries return as tool results, the parent
  synthesizes both, children hidden from the session list.
- **Docs.** `docs/SUBAGENTS.md` (contract, config, aborts, API, known
  simplifications); ARCHITECTURE (16-package graph, subagent isolation
  invariant), README, PROTOCOL (event catalogue + routes), example config.
- **Tests.** 865 total across 19 packages, 0 failures (49 new over Phase
  2's 816: 29 `@nyx/subagents`, 4 server routes, 2 CLI, 2 e2e incl.
  fan-out, 2 agent parallel-round, 4 session kind/migration, 3 protocol
  schemas, 3 config).

### Fixed — Phase 3 hardening (the real three-reviewer fan-out)

After steps 3.1–3.10 were green, three parallel review agents (R1: depth/
budget/allowlist; R2: abort/isolation; R3: tool-router filtering) reviewed
the shipped sources read-only and returned numbered findings with
severities. 20 findings total: 6 fixed in code, 14 verified-by-test or
accepted-with-reason (every acceptance documented in SUBAGENTS.md). Each
fix is locked in by a regression test.

- **Budget floor (R1, High).** A model-authored negative `budget_tokens`
  passed the compiled runtime schema (which drops `minimum`) and poisoned
  the per-turn allocation downward — `spent + budget` could never exceed
  `max_total_per_turn`, buying unbounded extra spawns. Fixed twice over:
  the tool boundary now enforces the advertised minimum (integer ≥ 1024,
  matching the schema the model was shown) and the manager rejects any
  non-positive-integer spec budget (`validation_failed`). The runtime-path
  regression test drives the poisoned input through a REAL parent turn.
- **Post-create throws can no longer zombie a child (R1+R2, High/Medium).**
  A throw after child-session creation (a failed mirrored append, a loop
  exploding before its own try/catch) used to propagate out of `spawn()`,
  leaving the child's log with `subagent.spawned` and no terminal event —
  `list()` reported it "running" forever and the copied approval presenter
  leaked. Now the whole post-create section is guarded: the throw becomes
  the child's failure per §2.4i — `subagent.failed` mirrored on both logs,
  `state="failed"` returned, `onSettled` fired, allocation left counted
  (conservative stickiness, documented).
- **Cross-process abort rows are ownership-aware (R2, High).**
  `takeSubagentAbortRequests` drained ALL rows and the poll dropped the ones
  it didn't own — with server and CLI both running subagents over one
  nyx.db, a bystander manager's poll could delete a request before its
  owner saw it, silently losing the abort. Replaced with
  `listSubagentAbortRequests` + per-row decisions: act+delete on owned
  children, delete on provably stale rows (settled/unknown session), LEAVE
  rows for children other processes own. Regression test proves all three
  row fates on two real connections to one file.
- **The abort poll is no longer starvable by streaming (R2, Medium).** The
  old pump raced a fresh `sleep(poll_ms)` against the next event — a child
  streaming faster than the poll interval never let the timer win, delaying
  cross-process aborts for the whole stream. The deadline is now checked at
  the TOP of the pump from a last-poll timestamp, so a drain happens at
  least every `poll_ms` regardless of event rate (proven with a
  continuously-streaming child and an abort row written pre-stream).
- **Abort now unblocks ask-waits (R2, Medium).** A child blocked in
  `approvals.request()` was not racing the abort signal (the Phase 2 runtime
  awaits the engine directly), so an abort took effect only at approval TTL
  (10 min). Every abort path (parent signal, budget, in-process, cross-
  process) now also withdraws the child's pending approvals via the new
  optional `ApprovalEngine.withdrawSession` protocol method (additive; the
  2.0.2 impl already had it) — the wait resolves deny and the abort lands
  immediately. Tested with a child genuinely blocked on an R2 ask.
- **The parent's memory catalog excludes the `subagent` scope (R2,
  Medium).** The loop's prompt-assembly catalog query was unscoped, so
  child-written `subagent`-scope memory titles (first 80 chars) could
  surface in the PARENT's next prompt — violating "summary only via
  SubagentResult". The catalog now queries session/persona/owner/global
  explicitly; a child reading its own memory is unaffected (its view
  translates). Plus: `SubagentMemory.list` over-fetches before ownership
  filtering so other children's rows can't truncate the child's own results
  (R2, Low), and `get()` ownership is now regression-tested.
- **Test gaps closed from the review (R2/R3, Low).** "Both logs" asserted
  per abort flavor (parent-abort, in-process, cross-process); abort-vs-
  budget precedence; the config-independence of the structural
  spawn_subagent gate (forbidden_tools emptied, spec names it — still
  absent); the child's outgoing model request offers no spawn_subagent
  (provider now records requests); a session STARTING at max depth lacks
  the tool and cannot spawn; `timeout_ms: 600_000` asserted; the
  cross-process test now uses two real connections to one file; the fanout
  fixture's one inaccurate claim corrected.
- **Accepted with reason (documented in SUBAGENTS.md):** in-flight budget
  depends on providers emitting usage chunks; crash reconciliation deferred
  to Phase 4 GC (no process-liveness data — a heuristic could kill live
  children of another process); typed rejection codes flatten to the
  runtime's `tool_failed` event code (Phase 0 behavior unchanged);
  `SubagentSpec.model` reserved but unwired; `fs.edit` omitted from the
  default allowlist (no such builtin — naming it would be dead config);
  rewrite-hooks vs. parallel-round classification; FilteredToolRegistry
  register/unregister delegation; `RunContext.tool_router` carried but
  unconsumed.
- **Suite after hardening.** **879 passed, 0 failed** (+8 platform-skipped
  sandbox tests), typecheck clean across all 19 packages, lint clean — 14
  new regression tests from the review findings.

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
