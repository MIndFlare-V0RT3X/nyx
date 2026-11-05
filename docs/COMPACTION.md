# Compaction

Phase 2's four-tier context pipeline (`packages/agent/src/compaction-pipeline.ts`).
Compaction is the capability multiplier behind long sessions and Phase 3
subagents: a subagent's summary return only matters if the main context can
hold multiple turn-rounds without blowing the window.

**Compaction never loses events.** Only the _message list presented to the
model_ is compacted. Elided content stays in the append-only event log;
recovery is `session.read()`. The pipeline never mutates its input list.

**Tool outputs are persisted (Philosophy B).** Every `tool.result` event —
including its full output block — is stored verbatim in the event log at
append time; elision is strictly PRESENTATIONAL (the model's view), never
storage. A `[elided tool output <id>]` marker in the context refers to a row
that still exists in full: `session.read()` returns it, retention archives
it, and the audit chain cross-references it. Nothing compaction does can
shorten the record.

## When it runs

The agent loop (step 7 of the turn sequence) invokes the pipeline when either
trigger fires:

- the token estimate of the assembled message list exceeds the compaction
  budget (`options.compaction_budget_tokens`, default 100 000), or
- the router reports the session budget exceeded with `on_exceed ≠ abort`.

The pipeline is looked up as kernel service `"agent.compaction"` so surfaces
can configure it from `context.compaction` in `nyx.config.yaml`; absent →
defaults. `enabled: false` disables it entirely.

## The tiers

Tiers run in order; **the first non-null plan is applied** (§3.1). Tier 4 is
the explicit exception: its precondition is "still exceeds after Tiers 1–3",
so it re-checks _after_ the first applicable tier ran and may follow it in
the same pass. (Documented interpretation — a single pass with only
"first non-null wins" could never reach Tier 4 after Tier 1 freed too little.)

### Tier 1 — rule-based elision

- **Precondition:** elidable tool_result blocks (older than the current turn)
  total more than `elision_threshold_tokens` (5000) — or the context is over
  budget at all, in which case every elidable token counts (the preserved
  Phase 0/1 trigger).
- **Apply:** oldest tool_result outputs become `[elided tool output <id>]`
  markers (FIFO), then oldest reasoning blocks drop, until the estimate fits
  80% of the budget. System sections are structurally immune.

### Tier 2 — session memory

- **Precondition:** the session has been active for more than
  `session_memory_min_turns` (20) turns **and** the estimate exceeds
  `session_memory_threshold` (60%) of the window.
- **Apply:** a cheap model call at `reasoning_effort: low` compacts
  everything before the last 5 _completed_ turns (plus the current one — the
  current ask is never compacted) into one system message
  (`[session memory …]`). The summary is written to `@nyx/memory` scope
  `session` (tags `compaction`, `session-memory`), so it survives restart
  and can be refreshed on later triggers. Target: under 60% of the window.

### Tier 3 — LLM summary

- **Precondition:** Tier 2 has been applied at least once in this session
  (a session-memory entry exists) **or** the estimate exceeds
  `llm_summary_threshold` (80%).
- **Apply:** a cheap model call summarizes the K = 10 messages _before the
  current ask_ into one assistant message with the shape
  `Decisions: / Current task state: / Open questions:`. The current ask is
  never summarized away.

### Tier 4 — emergency degrade

- **Precondition:** the estimate still exceeds `emergency_threshold` (95%)
  after Tiers 1–3 — a pathological turn (a huge tool output that keeps
  regrowing) or a config that cannot keep up.
- **Apply:** drop the oldest half of history immediately; the last 10
  messages are always retained. The persona preamble (leading system
  messages) survives when it fits ahead of the retained window — degrading
  the contract is not an acceptable emergency response. The operator is
  warned via the event strategy (`emergency-degrade`), the logger, and the
  channels' reply rendering; the truncation lands on the **hash-chained
  audit** (actor `system:compaction`). Ordinary compaction (Tiers 1–3) is
  routine context hygiene and stays event-log-only.

## Post-compaction re-read

After any tier that drops content, up to `post_compaction_reread_files` (5)
recently referenced files — `fs.read` / `fs.write` / `fs.edit` paths from the
last 20 turns, newest first — are re-read from the session sandbox into one
capped system message (`post_compaction_reread_tokens`, 5000). Without this,
an agent that was mid-file-edit loses the file. Unreadable files are skipped
silently; the model can re-read on demand.

## Configuration (`nyx.config.yaml`)

```yaml
context:
  compaction:
    elision_threshold_tokens: 5000
    session_memory_threshold: 0.60 # fraction of the window
    session_memory_min_turns: 20
    llm_summary_threshold: 0.80
    emergency_threshold: 0.95
    post_compaction_reread_tokens: 5000
    post_compaction_reread_files: 5
    enabled: true
    verbose_events: false # per-block diagnostics via debug logs
```

`verbose_events` routes per-block diagnostics to the logger's debug channel —
the frozen protocol event vocabulary has no per-block fields, and inventing
undocumented events would break every consumer.

## Events and audit

| event                                                                                                                            | when                           |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `compaction.started` / `compaction.completed` (strategy `rule-elision` / `session-memory` / `llm-summary` / `emergency-degrade`) | around each applied tier       |
| audit row `compaction.completed` (actor `system:compaction`)                                                                     | **emergency truncations only** |

Append and reconcile in `@nyx/policy` key on the same predicate
(`isEmergencyCompactionEvent`), so the cross-check stays symmetric.

## Tests

- `packages/agent/src/compaction-pipeline.test.ts` — every tier's trigger and
  apply, the ordering (first non-null wins; emergency after 1–3), the
  re-read, small-session no-op, `enabled: false`, defaults.
- Golden files `packages/agent/src/golden/` — deterministic apply shapes for
  Tiers 1, 3, 4 (regenerate with `WRITE_GOLDEN=1`).
- `packages/policy/src/event-audit.test.ts` — emergency audit symmetry.
- `tests/e2e/compaction.test.ts` — a large session crosses the budget,
  elides, completes, and the chain verifies; nothing is lost.
