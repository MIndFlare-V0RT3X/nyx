# Retention (Phase 4 §3)

Retention **archives, it does not delete**: a session past its window has
its event rows **moved** to the sibling archive database (`nyx-archive.db`,
ATTACHed on the same connection) and its `sessions` row marked
`archived = 1` / `archived_at`. The session stays resolvable (`meta()`, and
`list()` with `include_archived`) and fully readable — `session.read()`
serves the events from the archive. Hard deletion is a separate, opt-in
second pass that only ever touches sessions that are **already archived**.

Retention is a **scheduled durable task** (`nyx:retention-gc`), never a
startup sweep: the surface only ensures the task exists at boot; the worker
pool fires it on its cron. It **ships disabled** — `subagents.retention_enabled`
must be set `true` before the surface creates the task, because moving user
data to the archive database on first boot would otherwise surprise.

## What runs

- **Archive pass** (`retention_days > 0`, `retention_scope ≠ none`): sessions
  whose `updated_at` is past the window, filtered by scope:
  - `subagent` — subagent-kind sessions only (the Phase 3 spawn children);
  - `subagent+failed` — those, plus sessions tied to FAILED tasks (the
    tasks' own sessions; failed work's forensic value is otherwise kept);
  - `all` — every kind, primary sessions included;
  - `none` — nothing.
- **Deletion pass** (`delete_after_days > 0`, default off): sessions with
  `archived = 1` whose `archived_at` is past the horizon — their archive
  events are removed and the `sessions` row is hard-deleted. Live and
  soft-archived (Phase 3 `DELETE /v1/sessions/:id`) rows are never touched.

## What is protected

- Sessions tied to tasks in `pending` / `running` / `paused` — via the
  task's own session (`task_session_id`), its current attempt's child
  (`subagent_session_id`), and the parent it mirrors onto (`session_id`).
  Live work is never archived, under ANY scope.
- Sessions tied to FAILED tasks are kept unless the scope explicitly
  includes failed work (`subagent+failed`, `all`) — failure evidence has
  forensic value.
- The task's own log records every fire (`task.started` / `task.completed`),
  so a no-op pass is distinguishable from a never-run one.

## Crash discipline

The per-session move is **idempotent and re-runnable**: events are copied
into the archive (`INSERT OR REPLACE` over the shared global seq primary
key) BEFORE the main-db transaction that deletes them and marks the row. A
crash anywhere in between leaves the session unarchived until the next pass
— never half-archived, and never loses an event. `archived_at` keeps a
pre-existing soft-archive timestamp (the original archive time is evidence
too).

## The audit chain

Every pass that moves or deletes anything appends a hash-chained audit row:
`retention.archived` (scope, window, counts, protections) and
`retention.deleted` (horizon, counts). No-op passes append nothing (the
task's own session log is the run record). `verifyAuditChain` still passes.

## Reads after archiving

- `session.read()` / `stream()` route by residence: `archived = 1` reads the
  ATTACHed `archive.events` (same seqs, same shape); a store opened without
  an `archivePath` throws the typed `archived` error — loud, never a silent
  empty log.
- `append()` / `fork()` on an archived session are refused (`archived`): a
  log must never split across two databases.
- Projections are deleted with the events (they are rebuildable from the
  log); the archive stores events only, by design.

## Config

```yaml
subagents:
  retention_enabled: false     # SHIPS DISABLED — opt in
  retention_days: 7            # 0 = never archive
  retention_scope: subagent    # subagent | subagent+failed | all | none
  delete_after_days: 0         # 0 = off; only ever deletes ARCHIVED sessions
  retention_schedule: "30 3 * * *"  # daily 03:30 UTC
```

The server ATTACHes `<data_dir>/nyx-archive.db` on the unified handle at
startup (the store's `archivePath` option); the file is created on first
use, is event-only (no FKs — the sessions row stays in `nyx.db`), and is
readable cross-connection for external inspection.
