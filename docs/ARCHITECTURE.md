# Architecture

NYX is a local-first, memory-first, security-first personal agent runtime —
**the harness, not the model**. It turns a stateless LLM into a stateful
operator: sessions persist across restarts as append-only event logs, tool
execution happens inside sandboxes behind a deny-first policy broker, memory is
markdown you can read, and the persona is a first-class directory of files. The
model is a commodity plugged in through a provider-neutral router; the harness
is the capability.

NYX runs on the operator's machine. The only outbound network calls are to the
model providers the operator configured — hosted or self-hosted (llama.cpp, LM
Studio, vLLM, Ollama register identically to hosted endpoints). No telemetry,
no analytics, no phone-home.

## The package graph

Nineteen library packages, three applications, and an end-to-end test workspace.
`@nyx/protocol` is the frozen contract: every type that crosses a package or
process boundary lives there, and it imports nothing. Dependency direction is
machine-enforced by ESLint `no-restricted-imports` in `eslint.config.mjs`.

```mermaid
flowchart TD
  subgraph apps["apps"]
    SERVER["@nyx/server<br/>HTTP + SSE + WS + channels + heartbeat"]
    CLI["@nyx/cli<br/>nyx binary, TUI"]
    WEB["@nyx/web<br/>browser client"]
  end

  subgraph libs["packages"]
    PROTOCOL["@nyx/protocol<br/>frozen contracts"]
    CONFIG["@nyx/config"]
    KERNEL["@nyx/kernel"]
    SESSION["@nyx/session"]
    MODEL["@nyx/model"]
    SCOPE["@nyx/scope"]
    POLICY["@nyx/policy"]
    SANDBOX["@nyx/sandbox"]
    MEMORY["@nyx/memory"]
    PERSONA["@nyx/persona"]
    TOOLS["@nyx/tools"]
    AGENT["@nyx/agent"]
    RUNTIME["@nyx/runtime<br/>lane queue · cron · heartbeat"]
    CHANNELS["@nyx/channels<br/>webhook · Telegram · manager<br/>approval presenters"]
    SUBAGENTS["@nyx/subagents<br/>spawn · fork · artifact handoff"]
    TASKS["@nyx/tasks<br/>durable tasks · SQL leases · retention"]
    SKILLS["@nyx/skills<br/>SKILL.md · catalog · load_skill"]
    SECURITY["@nyx/security<br/>engagements · scope engine · findings · reports"]
    DB["@nyx/db<br/>unified nyx.db · split-DB migration"]
  end

  E2E["tests/e2e — @nyx/e2e"]

  SECURITY --> PROTOCOL
  SECURITY --> SCOPE
  SECURITY --> TOOLS
  SERVER --> SECURITY
  CLI --> SECURITY

  CONFIG --> PROTOCOL
  KERNEL --> PROTOCOL
  SESSION --> PROTOCOL
  MODEL --> PROTOCOL
  SCOPE --> PROTOCOL
  POLICY --> PROTOCOL
  SANDBOX --> PROTOCOL
  MEMORY --> PROTOCOL
  PERSONA --> PROTOCOL
  AGENT --> PROTOCOL
  TOOLS --> PROTOCOL
  TOOLS --> POLICY
  TOOLS --> SCOPE
  TOOLS --> SANDBOX
  RUNTIME --> PROTOCOL
  SUBAGENTS --> PROTOCOL
  SUBAGENTS --> AGENT
  SUBAGENTS --> TOOLS
  SUBAGENTS --> MEMORY
  SUBAGENTS --> MODEL
  SUBAGENTS --> SESSION
  SUBAGENTS --> POLICY
  SUBAGENTS --> SANDBOX
  TASKS --> PROTOCOL
  TASKS --> RUNTIME
  TASKS --> POLICY
  TASKS --> SESSION
  SKILLS --> PROTOCOL
  CHANNELS --> PROTOCOL
  CHANNELS --> POLICY
  DB --> PROTOCOL
  DB --> POLICY
  DB --> SESSION
  DB --> CHANNELS
  DB --> RUNTIME

  SERVER -->|"imports every @nyx/* package"| libs
  CLI -->|"imports every @nyx/* package"| libs
  E2E -->|"drives the composed packages"| libs
  WEB -.->|"HTTP / SSE / WS only — no @nyx imports"| SERVER
```

What the arrows encode:

- **protocol ← everything.** All shared types plus the Zod boundary schemas
  (`packages/protocol/src/schemas.ts`) live in one dependency-free package.
  Cross-package imports go through `@nyx/<pkg>` (`index.ts` exports) only,
  never a deep path.
- **tools → policy, scope, sandbox.** The tool runtime is the single place that
  composes the enforcement pipeline (see `docs/PROTOCOL.md`). No other package
  may compose policy with execution.
- **runtime → protocol only.** Orchestration, not policy: the lane queue
  (per-session serial execution, global concurrency cap, round-robin
  fairness) and the heartbeat scheduler (hand-rolled cron + SQLite state) hold
  no secrets and make no decisions — they sequence work that other packages
  already authorized.
- **channels → protocol, policy.** Adapters are transport (webhook listener,
  Telegram long-poll) plus a manager that checks identity against config
  allow lists, maps conversations to sessions, and handles `/new` and
  `/fork`. Every channel turn is driven through the host's TurnRunner — the
  same lane, loop, policy, and approvals as the HTTP API. Channels add no
  parallel policy path. Since Phase 2 they also carry the approval
  _presenters_ (pure surface: inline keyboards, `approval_required` bodies)
  — the decision authority stays in the engine and the resolve route.
- **db → protocol, policy, session, channels, runtime.** The unified
  database (Phase 2 §2.0.1): one `nyx.db` file, one connection, one
  transaction per event+audit append. `@nyx/db` is the only package that
  knows every table owner — it ensures each owner's schema on the shared
  handle and migrates the Phase 0/1 split layout (policy.db, channels.db,
  heartbeat.db) in a single chain-verified transaction, renaming the legacy
  files (never deleting them).
- **subagents → protocol, agent, tools, memory, model, session, policy, sandbox.**
  The Phase 3 subagent system (Phase 4: fork-per-child sandboxes + the
  hash-audited artifact handoff): `SubagentManager.spawn` creates a child session
  (`kind="subagent"`), builds the child `RunContext` — a `FilteredToolRegistry`
  view (spawn_subagent structurally absent, spec allowlist minus forbidden
  tools), a tool runtime over that filtered registry, an isolated
  `SubagentMemory` view, a budget-tracking model router, the parent's sandbox /
  policy / approvals / persona — and runs `AgentLoop.run` with the task. Only
  the final summary crosses back, as the `spawn_subagent` tool result
  (`docs/SUBAGENTS.md`). Nothing depends on it except `@nyx/server` and
  `@nyx/cli`, which wire it.
- **tasks → protocol, runtime, policy, session.** The Phase 4 durable-task
  substrate (`docs/TASKS.md`): a `tasks` table in the unified `nyx.db`, SQL
  leases as the ONLY cross-process coordination (a claim is one conditional
  UPDATE; TTL 5 min, renewal 30 s, crash reclaims consume attempts so poison
  tasks converge), the full state machine enforced by the `WHERE` clauses,
  cron recurrence, and the retention engine (`docs/RETENTION.md`) that runs
  as the `nyx:retention-gc` system task — archive-not-delete into the
  ATTACHed `nyx-archive.db`, hash-chained audit rows, live work never
  archived. System tasks never spawn a subagent; the runner branch executes
  them directly.
- **skills → protocol.** The Phase 4 progressive-disclosure system
  (`docs/SKILLS.md`): SKILL.md scanning (configured dirs + the persona's
  own), a per-session catalog injected through the `context.initialize`
  hook into the `SKILLS_CATALOG` prompt section (persona-scoped,
  capability-filtered, curated under a token cap), and the R0 `load_skill`
  tool — skills are trusted content, loading grants nothing. The Phase 5
  security subsystem's delivery surface.
- **agent → protocol only, via DI.** The loop imports types; every collaborator
  — kernel, session store, model router, tool registry and router, policy and
  approval engines, sandbox, memory, persona runtime — arrives through the
  `RunContext` it is handed (`packages/protocol/src/agent.ts`). There is no
  construction inside the loop body.
- **server, cli → everything.** The surfaces compose the runtime and expose it:
  the server as HTTP/SSE/WS plus channel ingress and heartbeats
  (`apps/server`, Hono + ws), the CLI as the `nyx` binary (Commander + Ink).
- **web → HTTP only.** The browser client talks to the server's REST/SSE/WS API
  and imports no `@nyx/*` package.
- **tests/e2e** drives the composed packages the way surfaces will: smoke,
  approval, replay, and scope scenarios against the real implementations.

Current state (Phase 2): all packages implemented with test suites — including
`@nyx/db` (unified database), `@nyx/runtime` (lane queue, cron, heartbeat,
timezone-aware schedules), `@nyx/channels` (webhook, Telegram, interactive
approvals), and the four-tier compaction pipeline in `@nyx/agent`
(`docs/COMPACTION.md`). See `docs/ROADMAP.md` for Phase 3 scope.

## The trust boundary

Four trust zones. Credentials, policy, and audit live in the trusted zone; the
model-facing loop is semi-trusted and holds no long-lived secrets; tool
execution is untrusted and sandboxed; model providers are external by
definition.

```mermaid
flowchart TD
  KERNEL["KERNEL — trusted<br/>config · credentials by env-var name<br/>policy engine · approvals · hash-chained audit<br/>the SQLite event store"]
  AGENT["AGENT RUNTIME — semi-trusted<br/>the loop · prompt assembly<br/>model calls · tool dispatch<br/>no long-lived secrets"]
  TOOL["TOOL RUNTIME + SANDBOX — untrusted<br/>execution in an isolated workdir<br/>(docker: network none)<br/>no ambient authority · no host fs · no credentials"]
  PROVIDER["MODEL PROVIDER — external<br/>sees prompts and tool schemas only<br/>never credentials, audit, or host paths"]

  KERNEL -- "structured events and interfaces" --> AGENT
  AGENT -- "validated, path-contained ToolCalls" --> TOOL
  TOOL -- "ToolOutput — untrusted data" --> AGENT
  AGENT -- "CompletionRequest" --> PROVIDER
  PROVIDER -- "ModelChunk stream" --> AGENT
```

- **Kernel (trusted).** May hold configuration, credential env-var names, the
  policy and approval engines, the audit chain, and the event store. May
  evaluate policy, resolve approvals, append events. May not execute
  model-generated code.
- **Agent runtime (semi-trusted).** May assemble prompts, call the model
  router, dispatch tool calls through the runtime, and emit session events. May
  not hold long-lived secrets, bypass the policy broker, or touch the host
  filesystem directly.
- **Tool runtime + sandbox (untrusted).** Handlers receive a `ToolContext`
  whose `sandbox` is their only route to the outside world and whose `emit` is
  their only route to the event log (`packages/protocol/src/tools.ts`). No
  ambient authority; every path is resolved against the sandbox workdir.
- **Model provider (external).** Receives prompts and curated tool schemas
  (`ToolSchema`), never handlers, credentials, audit data, or host paths.

Phase 0 composed these zones inside one server process; the seams were enforced
structurally (dependency direction, the policy broker, the sandbox) rather than
by OS process isolation. **Phase 7.3 makes the split structural**: `NYX_PROCESS_MODE=split`
boots three processes — nyx-kernel (trusted: config, credential vault,
policy, audit, nyx.db, sessions, tasks, memory), nyx-agent (semi-trusted: loop,
prompts, persona, model router, remote views — no credentials, no db handle,
no data dir), nyx-tools (untrusted: registry, runtime, sandbox) — joined by a
token-authenticated JSON-RPC unix socket (`@nyx/ipc`). Single mode remains
the default and byte-identical to Phase 6; the full model, scope notes, and
both modes' guarantees are in `docs/PROCESS-MODEL.md` and
`docs/SECURITY-MODEL.md`.

## Event sourcing

The append-only event log is the only source of truth; everything else is a
projection (`@nyx/session` on better-sqlite3 + drizzle, WAL mode).

- **One database (2.0.1).** Everything lives in `nyx.db` (WAL,
  `synchronous=FULL`, `busy_timeout=5000`): the event log and its
  projections, the approval engine and the hash-chained audit table, channel
  session mappings, and heartbeat state. `@nyx/db` opens the shared handle
  and migrates any Phase 0/1 split layout in one verified transaction.
- **Append.** `SessionStore.append(session_id, events)` inserts events,
  updates projections, and — through the `onEventsCommitted` hook — writes
  the matching hash-chain audit rows, all in ONE transaction: a crash
  between the event and audit writes leaves neither row. `seq` is assigned
  by the store — a
  single global, monotonic, never-reused `AUTOINCREMENT` across all sessions
  (per-session seqs are strictly increasing but not contiguous under
  interleaved appends). Payloads are stored as canonical JSON (sorted keys,
  `undefined` dropped) so replays reproduce byte-identical values.
- **Projections.** `messages` (from `message.user` / `message.assistant` —
  deltas are not stored), `tool_calls` (status machine `pending → ok | error |
denied`), `approvals` (upsert on `approval.requested`, resolved on
  `approval.resolved`), `usage` (summed from `turn.completed` at read time),
  and `projection_version` (the per-session applied horizon). Projection rows
  are pure functions of `(event payload, seq)` — no clocks, no randomness.
- **Subagent sessions (Phase 3).** `SubagentManager.spawn` creates a child
  session with `kind="subagent"` and `parent_id` lineage; the four
  `subagent.*` lifecycle events are mirrored on BOTH logs (the parent's copy
  carries `subagent_session_id`, the child's denormalizes
  `parent_session_id`). Child turn events never enter the parent's log — only
  the summary crosses, as the `spawn_subagent` tool result. Archiving
  (`DELETE /v1/sessions/:id`) marks `archived_at` and deletes nothing.
- **Fork.** `fork(session_id, at_seq)` copies the parent's events with
  `seq <= at_seq` into a new session under fresh global seqs (only the
  payload's `session_id` is rewritten), copies owner/persona/engagement, and
  appends a `session.forked` event to the parent's log. The child's prefix is
  identical; both sessions continue independently.
- **Replay and rebuild.** `rebuildProjections()` truncates the projection
  tables and replays the log in global seq order; the result is byte-identical
  to the incremental state (tested to 10,000 events). Reading a session is
  `read(session_id, from_seq)`; live tailing is the `stream()` async iterator,
  which replays from `from_seq` then polls for new events.

## One loop, many surfaces

There is exactly one agent loop (`@nyx/agent`, contract in
`packages/protocol/src/agent.ts`): `AgentLoop.run(input, ctx)` yields every
session event the turn produces, in order, as it happens. A turn is: initialize
context (hook) → assemble the system prompt from the persona runtime → build
the message list from the session projection under the compaction budget →
stream from the model router, appending deltas → for each tool call, run the
enforcement pipeline → append results and continue until no tool calls remain
or the round cap is hit → `turn.completed` (or, after one recovery attempt,
`turn.failed`). A round whose calls are ALL `concurrency: "parallel"`
(currently only `spawn_subagent`) dispatches concurrently, with results
reassembled in call order (Phase 3); any serial-classified call keeps the
round sequential.

Every surface — server, CLI, SDK, e2e tests — constructs a `RunContext` and
drives the same loop. Only rendering differs. Adding a channel (Phase 1) means
adding a surface, not a loop.

## The scope engine

`@nyx/scope` turns an `Engagement` (the immutable target set bound at session
creation) into a pure `ScopeChecker` closure for the tool runtime. Evaluation
order is expiry → inclusion → exclusion → port policy: an expired engagement
denies everything before any other check; an IP literal must be contained by a
declared CIDR (domains never authorize raw IPs); a hostname must suffix-match a
declared domain on a dot boundary (`example.com` covers `app.example.com`,
never `evil-example.com`); exclusions override inclusions; the port deny list
always wins and an allow list restricts when present. `validateTargets` runs at
session creation so bad CIDRs, domains, and ports are rejected before a session
exists. The engine is deliberately literal-string based — no DNS resolution, no
pinning (see `docs/SECURITY-MODEL.md` for what that does and does not defend).

## Building and testing

```bash
pnpm build                              # turbo run build (all packages)
pnpm test                               # turbo run test (vitest run, non-watch)
pnpm lint                               # eslint .
pnpm format:check                       # prettier --check
pnpm e2e                                # pnpm --filter @nyx/e2e test

# Per package (the working agreement — both must pass before reporting):
pnpm --filter @nyx/<pkg> build
pnpm --filter @nyx/<pkg> test
```

Docker-dependent tests are skippable (`NYX_SKIP_DOCKER=1` or no Docker
available). ESM only, TypeScript strict, SPDX headers on every source file —
see `BUILD-CONVENTIONS.md`.

## Key invariants

| Invariant                         | Meaning                                                                                                                                                                                                                             | Where it lives                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Frozen policy                     | Structural invariants are hardcoded and evaluated before config rules; nothing can weaken them                                                                                                                                      | `@nyx/policy` `PolicyEngineImpl`              |
| Four hooks                        | The entire editable behavioral surface is `context.initialize`, `action.before`, `action.after`, `feedback.recover`; hooks return structured effects, the kernel interprets them                                                    | `@nyx/protocol` `hooks.ts`                    |
| Output separation                 | The component being judged never writes the judgment: verdicts, approvals, and audit are written by the policy engine, and projections are pure functions of events                                                                 | `@nyx/policy`, `@nyx/session`                 |
| Event sourcing                    | Append-only log is the only truth; all state is a rebuildable projection; replay and fork are free                                                                                                                                  | `@nyx/session`                                |
| Router / registry / runtime split | Tool selection, catalog, and execution are three objects; the model sees a curated `ToolSchema`, never handlers. Same shape for models: registry / router / providers                                                               | `@nyx/protocol` `tools.ts`, `model.ts`        |
| Deny-first                        | `deny > ask > allow`; unknown actions escalate to ask; risk tiers R0–R4                                                                                                                                                             | `@nyx/policy`                                 |
| Trust boundary is structural      | Credentials are env-var names resolved at call time; the sandbox has no ambient authority; the loop holds no long-lived secrets                                                                                                     | `@nyx/config`, `@nyx/model`, `@nyx/sandbox`   |
| Isolation over coordination       | Tool execution happens inside a sandbox; path containment is enforced centrally in the tool runtime and re-enforced by providers; engagement sandboxes egress ONLY through the kernel-process proxy (Phase 6, docs/EGRESS-PROXY.md) | `@nyx/sandbox`, `@nyx/tools`, `@nyx/security` |
| Progressive disclosure            | Catalogs up front, bodies on demand: memory titles, skill one-liners, tool one-liners in the prompt                                                                                                                                 | `@nyx/persona`, `@nyx/protocol` `persona.ts`  |
| One loop, many surfaces           | A single `AgentLoop`; every surface drives it via `RunContext` DI                                                                                                                                                                   | `@nyx/agent`, `@nyx/protocol` `agent.ts`      |
| Subagent isolation is structural  | A subagent's registry lacks `spawn_subagent` by construction (enforced on the execution path, not the catalog); its memory is an isolated view; only its summary crosses back; depth/budget are checked before the child exists     | `@nyx/subagents`                              |
