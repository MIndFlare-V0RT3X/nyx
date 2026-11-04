# MEMORY

Human-readable index of durable memory. The machine index (SQLite FTS5) is
the source of truth for retrieval; this file is the mirror the assistant
can open directly with `fs.read`. Keep one line per entry. Entries are not
auto-appended yet (planned); add them by hand and prune by hand when they
go stale.

## Owner scope

- (no owner-scope memories yet)

## Persona scope

- (no persona-scope memories yet)

## Session scope

- (session memories are per-session and summarized at compaction time)
