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
  has no bundled LLM. The fan-out validation in `tests/e2e/fanout-review.test.ts`
  scripts the reviewer models: the reads/greps are real (executed against the
  real sources through the real tool pipeline), the findings text is
  Fizz-authored from reviewing the same files.
- **Child turn id shape:** the child's turn is `sub-<nanoid>`; the subagent
  event's `turn_id` field carries it on both logs.
- **Live TUI token counter:** the spawn card shows the task and, on
  completion, the result; a live per-child token counter needs child-event
  subscription in the TUI (deferred).
- **Budget allocation stickiness:** an allocation is rolled back only when
  session creation fails; a later throw leaves it counted (conservative —
  over-counting denies, never overspends).
