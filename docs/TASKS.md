# Durable Tasks (Phase 4 §2)

Long-running work that survives restart, can be paused and resumed, retries
on failure with backoff, recurs on cron — and executes as a **subagent** so
its context never pollutes the parent's window. The `tasks` table in the
unified `nyx.db` is the substrate; **SQL leases** coordinate workers across
processes — no coordination primitive beyond the conditional `UPDATE`.

## The shape

A task is a `TaskSpec`: a model-facing `description` (the task prompt), a
`subagent_spec` (everything a spawn needs except the task text), an optional
`parent_session_id` binding (task events mirror onto the parent's log), a
`max_attempts` / `retry_backoff_ms` ladder (exponential: base × 4^(n−1)), an
optional wall-clock `timeout_ms`, and an optional 5-field cron `schedule`
that makes the task recurring (after a successful run it resets to `pending`
at the next fire — never completed, never double-fired inside one window).

Every task owns its **own session** (`task_session_id`): its metadata log
lives there, its subagents hang off that lineage, and `task.*` events land
on both its own log and the bound parent's (the task's own log is the record
of truth; a failed parent mirror is a warning, never a broken transition).

## The state machine

```
pending ──claim──► running ──success──► completed
                     │
                     ├──failure<max──► (backoff) ──► pending
                     ├──failure≥max──► failed
                     ├──pause()──► paused ──resume()──► pending
                     └──cancel()──► cancelled
```

`cancel()` is legal from ANY state (including cancelled — idempotent);
`retry()` is the `failed`/`cancelled → pending` edge and resets `attempts`.
Illegal transitions **throw** (`illegal_transition`), never silently coerce —
legality is enforced by the database itself: every mutation is a conditional
`UPDATE` whose `WHERE` clause encodes the edge, so two racing writers cannot
both win and a writer whose precondition no longer holds gets 0 rows (turned
into `illegal_transition` / `lease_lost` by the caller).

## Leases (§2.1.3)

- **claim** — one conditional `UPDATE` flips a DUE pending row (due-ness is
  part of the claimable edge: `next_attempt_at IS NULL OR <= now`) or a
  lease-expired running row to `running` under this worker's id. SQLite
  serializes writers (one write txn at a time, WAL + busy_timeout), so
  exactly one contender wins.
- **renew** — every `renew_interval_ms` while the attempt runs; a renew that
  loses (lease stolen after expiry) aborts the attempt: the new owner owns
  the run. A renew cadence ≥ the TTL is rejected at config load AND at pool
  construction (that window is a live double-execution).
- **release** — graceful shutdown aborts the running attempt and moves the
  expiry into the past (the owner name stays for forensics): another worker
  can reclaim immediately. The dying worker never retries its own aborted
  attempt.
- **crash reclaim** — an expired lease is claimable by any worker; the
  reclaim consumes the crashed owner's attempt (the `attempts` counter
  increments on foreign reclaims), so a poison task that crashes its workers
  converges to `failed` at `max_attempts` instead of looping forever.

The **worker pool** (default 2 workers per process, 500ms scan, 5-minute
TTL, 30s renewal) starts with the process when `tasks.enabled` is true.
Multiple NYX processes on the same `nyx.db` share the queue by lease
contention — nothing else coordinates them.

## Priorities and lanes

`priority: "interactive" | "background"` (default background) is recorded on
the spec; the worker drains `pending` rows in `created_at` order. Task
attempts execute as subagent spawns — one at a time per worker slot.

## Retention is a durable task (§3)

The retention/GC pass (`nyx:retention-gc`) is ITSELF a scheduled durable
task — see [RETENTION.md](RETENTION.md). It ships **disabled**
(`subagents.retention_enabled: false`); the surface only *ensures the task
exists* at boot (create when absent, revive when terminally failed or
cancelled, leave a healthy or deliberately paused task untouched) — the
worker pool fires it on its cron. Never a startup sweep.

## Surfaces

- HTTP: `POST /v1/tasks`, `GET /v1/tasks?state=&parent_session_id=`,
  `GET /v1/tasks/:id`, `POST /v1/tasks/:id/pause|resume|retry`,
  `DELETE /v1/tasks/:id` (cancel).
- CLI: `nyx tasks list|show|pause|resume|retry|cancel` — reads and mutations
  from a separate process; a cancel of a RUNNING task leaves a
  `subagent_abort_requests` row for the process actually running the attempt
  (the same cross-process pattern `nyx subagents abort` uses).

## Config

```yaml
tasks:
  enabled: true                 # worker pool starts with the process
  workers: 2                    # per process
  poll_interval_ms: 500
  lease_ttl_ms: 300000          # 5 minutes
  renew_interval_ms: 30000      # MUST be < lease_ttl_ms (validated)
```

## Events

`task.created / started / completed / failed / paused / resumed / cancelled /
retrying` — on the task's own log, mirrored onto the bound parent's log.
System tasks (`nyx:` id prefix — retention GC) never spawn a subagent: the
runner branch executes them directly and synthesizes the `SubagentResult`.
