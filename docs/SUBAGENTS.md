# Subagents (Phase 3)

A subagent is a child **session** with its own context window, a narrowed tool
registry, an isolated memory view, and the parent's sandbox. It runs one turn
with a single task and returns **only its final summary** to the parent — as
the `spawn_subagent` tool result. Everything else (its events, its tool calls,
its token spend) stays in its own session, fully persisted and replayable.

```
parent turn
  └─ tool.call spawn_subagent {task}
       ├─ child session (kind=subagent, own event log, own SSE stream)
       │    └─ AgentLoop.run("You are a subagent. Your task: …")
       └─ tool.result = SubagentResult {session_id, summary, state, tokens_used, duration_ms}
```

## The contract

| Boundary            | Enforcement                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| Context             | The child burns its own window; the parent sees only the summary.           |
| Depth               | `subagents.max_depth` (default 3; 0 = no spawning). Counted over the `parent_id` chain. A spec's `max_depth_override` may only tighten. |
| Budget              | Per subagent: `min(spec.budget_tokens ?? default, max_budget_tokens)` — a spec may request **less, never more**. Per parent turn: the sum of allocations ≤ `max_total_per_turn`. A running child that crosses its budget is aborted with `state="budget_exceeded"`. |
| Tools               | The child's registry is a filtered view: `spawn_subagent` is **structurally absent** (hard rule, not config), `forbidden_tools` never pass, and only the spec's allowlist (intersected with the parent's registry) survives. The child's *tool runtime* is built over the filtered registry, so an attempted call is a clean `tool_unknown`. |
| Memory              | The child's memory is a `SubagentMemory` view: `session`-scope writes map onto the `subagent` scope keyed by the child's session id; reads see only its own `subagent` entries plus `global`. The parent's session memory is unreachable — by API surface, not instruction. |
| Sandbox             | Shared with the parent (`sandbox_sharing: "inherit"`; `"fork"` is Phase 4+ and errors loudly today). Concurrent children editing the same files is the parent's problem — conflicts surface as normal tool errors. |
| Events              | `subagent.spawned/completed/failed/aborted` are mirrored on BOTH logs (the parent's copy carries `subagent_session_id`; the child's copy denormalizes `parent_session_id`). Child turn events **never** enter the parent's log. |
| Approvals           | The child inherits the policy engine and approval engine. Surfaces copy the parent session's presenter onto the child (server), or surface child approvals through the engine callbacks (CLI) — an "ask" inside a child is interactive, not a TTL death. |
| Persistence         | Subagent sessions live in `nyx.db` (`sessions.kind = 'subagent'`, lineage via the existing `parent_id`). No GC in Phase 3; `subagents.retention_days` (default 7) is the Phase 4 heartbeat-GC knob. Deletion **archives**: `DELETE /v1/sessions/:id` marks `archived_at`, hides the session from lists, and keeps every row — the id stays resolvable and the log replayable. |

## Configuration (`nyx.config.yaml`)

```yaml
subagents:
  max_depth: 3                       # 0 = no spawning at all (tool absent)
  max_total_per_turn: 200000         # tokens across all subagents of one turn
  default_budget_tokens: 32768       # per subagent
  max_budget_tokens: 65536           # per-subagent ceiling (spec can only go lower)
  default_allowed_tools:             # when a spec doesn't name tools
    - fs.read
    - fs.write
    - fs.list
    - shell.exec
    - web.fetch
  forbidden_tools:                   # always blocked, cannot be overridden
    - spawn_subagent                 # no, subagents don't spawn subagents
    - spawn_subagent_v2
  sandbox_sharing: "inherit"         # "fork" is Phase 4+
  retention_days: 7                  # Phase 4 GC knob
```

The section is optional; every key has the default shown. `sandbox_sharing:
"fork"` fails at startup until Phase 4.

## Parallelism

`spawn_subagent` declares `concurrency: "parallel"`. A model round whose
calls are **all** parallel-classified dispatches concurrently: two spawns in
one round overlap (verified by event-timestamp windows in the e2e suite), and
the tool results still assemble in call order. Any serial-classified call in
the round keeps the whole round sequential — two `shell.exec` calls never
overlap.

## The tool path

```
surface (server / CLI)                    SubagentManager
  runTurn: bindTurn(session, turn, ctx) ──► turns map (lane-serial: one live turn per session)
    loop → tool.call spawn_subagent ──────► boundTurn(session, turn)
    tool runtime ── handler ──────────────► spawn(spec, parent_ctx, {session_id, turn_id})
                                              depth check → budget check → child session
                                              mirrored events → child RunContext → loop.run
  finally: unbindTurn(session) ◄────────── SubagentResult (tool.result, JSON)
```

The `RunContext` carries no session id, so the tool resolves its parent
through the manager's per-turn binding — the surface brackets every turn with
`bindTurn`/`unbindTurn`, and the lane queue guarantees at most one live turn
per session.

## Aborts

Three paths, all ending in `subagent.aborted` on both logs:

1. **Parent abort** — the parent turn's signal aborts the child controller
   (hard rule: abort propagation is not optional).
2. **Budget** — the budget-tracking model router aborts the child when its
   spend crosses its allocation (`state="budget_exceeded"`).
3. **External** — `DELETE /v1/subagents/:id` (owner-only, in-process) or
   `nyx subagents abort <id>` (any process: writes a `subagent_abort_requests`
   row on `nyx.db`; the owning manager drains it on its 150 ms poll — the same
   cross-process pattern the approval engine uses).

**Provider contract:** abort teardown relies on the model provider honoring
`CompletionRequest.signal`. The bundled OpenAI-compatible and Anthropic
providers pass the signal to their SDK clients. A provider that ignores it
leaves the child hanging until the spawn tool's 10-minute wall clock.

## HTTP API

| Route | Behavior |
| --- | --- |
| `GET /v1/sessions` | Excludes `kind='subagent'`; `?include_subagents=true` includes them. |
| `GET /v1/sessions/:id/subagents` | The parent's children with states (restart-safe: reconstructed from the event log). |
| `DELETE /v1/subagents/:id` | Owner-only abort (running children only; 400 for non-subagent sessions). |
| `DELETE /v1/sessions/:id` | Subagent sessions only: abort if running + archive (never hard-delete). |
| `GET /v1/sessions/:id/events` | A child's own SSE stream — same handler, no change. |

## CLI

```
nyx subagents list <parent_id>    # children: id, state, spawned, turn, task
nyx subagents abort <child_id>    # cross-process abort via nyx.db
nyx sessions list [--all]         # --all shows subagents with a ↳ prefix + parent
nyx sessions show <id>            # prints "subagent of <parent> (turn <id>)" for children
```

The chat TUI renders the spawn card as `↳ subagent <task>`; the child session
id arrives with the tool result and can be watched in another pane via
`nyx sessions show <id> --events`.

## Compaction interaction

A subagent summary counts against the parent's context budget like any tool
output; Tier-1 elision applies normally. The subagent's full session is never
in the parent's context — only its summary. Inside the child, the four-tier
pipeline runs with the child's own (isolated) memory view: Tier-2 session
memory lands in the `subagent` scope, so a child's compaction can never touch
the parent's session memory.

## Known simplifications (documented, not hidden)

- **Reviewer provenance (§5.1 fan-out):** NYX is a harness, not a model — it
  has no bundled LLM. The fan-out validation ran twice: (a) scripted in
  `tests/e2e/fanout-review.test.ts` — the reads/greps are real (executed
  against the real sources through the real tool pipeline), the findings text
  is Fizz-authored; and (b) for real — three parallel review agents (depth/
  budget/allowlist, abort/isolation, tool-router filtering) reviewed the
  shipped sources and returned numbered findings with severities. Their
  findings drove the hardening round documented in the CHANGELOG: the budget
  floor, post-create failure finalization, ownership-aware abort rows, the
  non-starvable poll, abort-time approval withdrawal, and the subagent-scope
  catalog exclusion are all review outcomes, each locked in by a regression
  test in `packages/subagents/src/manager.test.ts`.
- **Child turn id shape:** the child's turn is `sub-<nanoid>`; the subagent
  event's `turn_id` field carries it on both logs.
- **Live TUI token counter:** the spawn card shows the task and, on
  completion, the result; a live per-child token counter needs child-event
  subscription in the TUI (deferred).
- **Budget allocation stickiness:** an allocation is rolled back only when
  session creation fails; a later throw leaves it counted (conservative —
  over-counting denies, never overspends). The throw itself, however, is
  finalized: a post-create failure mirrors `subagent.failed` and returns
  `state="failed"` (§2.4i), so a mid-flight throw can never leave a child
  "running" forever.
- **Budget floor:** a spec's `budget_tokens` must be a positive integer at
  the manager and at least 1024 at the tool boundary (the advertised schema
  minimum — the runtime's compiled schema drops `minimum` by design). The
  config may set smaller budgets (`default_budget_tokens` is operator
  territory); a negative or zero spec budget is a validation error, never a
  downward poison of the per-turn allocation.
- **In-flight budget needs usage chunks:** the per-child budget guard counts
  `usage` chunks as they stream. A provider that omits usage leaves the
  in-flight guard unarmed for that stream (the per-turn allocation cap still
  holds); the real providers emit usage on every stream.
- **Crash reconciliation is Phase 4:** if the OWNING PROCESS dies mid-child,
  the child's log keeps `subagent.spawned` with no terminal event and lists
  as "running" until `subagents.retention_days` GC lands (Phase 4 heartbeat
  task). No heuristic is fabricated here: without process-liveness data,
  auto-failing such children could kill live children owned by another
  process (server + CLI local runtime can both run subagents on one nyx.db).
- **Cross-process abort rows are ownership-aware:** a manager's poll deletes
  only rows it acted on (its own children) or rows that are provably stale
  (settled/unknown session). A row for a child running in another process
  survives until that process's poll consumes it; a row whose owner died is
  cleaned by the next drain after the child settles.
- **Typed rejection codes flatten at the runtime:** a `depth_exceeded` or
  `budget_exceeded` SubagentError reaches the model as a `tool.error` whose
  event code is the runtime's generic `tool_failed` (Phase 0 behavior,
  unchanged by policy); the typed code is in the message and is asserted at
  the manager level by the test suite.
- **`SubagentSpec.model` is reserved, not wired:** the protocol schema
  accepts a per-subagent model override; the manager runs every child on the
  parent's router (a `BudgetTrackingRouter` over it). The field is inert
  until Phase 4 gives model routing a per-child chain.
- **`fs.edit` is not in the default allowlist:** the brief's §2.6 example
  lists it, but the builtin registry has no `fs.edit` tool — naming it would
  be dead config (the allowlist intersects the parent registry). The default
  lists the five real tools.
- **Rewrite hooks vs. parallel rounds:** the loop classifies a round
  parallel/serial from the ORIGINAL tool names; an `action.before` hook that
  rewrites a parallel-classified call to a serial-classified tool name would
  see it dispatched in the parallel lane. Hooks are trusted plugin code; the
  documented invariant (two `shell.exec` never overlap) holds for
  unrewritten names. Re-classifying post-rewrite is a Phase 4 hardening
  candidate.
- **`FilteredToolRegistry.register/unregister` delegate to the parent
  registry:** a plugin registering a tool during a child turn mutates the
  process-wide registry (the child's already-fixed allowlist cannot gain
  tools from it — the snapshot is taken at spawn). Trusted-plugin territory,
  documented stance.
- **`RunContext.tool_router` is carried but unconsumed:** the loop routes
  through the kernel service `tools.runtime` and `ctx.tools`; the field is
  protocol surface for future routing extensions. The child's inline router
  is consistent with the filtered registry it sits over.
