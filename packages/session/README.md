# @nyx/session

The NYX session store: an append-only SQLite event log (the single source of
truth for every session) plus rebuildable projections (`messages`,
`tool_calls`, `approvals`, tracked by `projection_version`). It implements
`SessionStore` from `@nyx/protocol` — create, append, read, live stream, fork,
meta/list, projection, and full replay — on better-sqlite3 (WAL,
`foreign_keys=ON`) with drizzle-orm used for schema definitions and
non-hot-path queries, and raw prepared statements for append/read.

## Public exports

```ts
import {
  openSessionStore,
  SessionStoreImpl,
  SessionStoreError,
  APPROVAL_TTL_MS,
} from "@nyx/session";
import type { SessionStoreOptions, SessionStoreErrorCode } from "@nyx/session";

// Opens (creating and migrating) the store. ":memory:" works.
function openSessionStore(path: string, opts?: SessionStoreOptions): SessionStore;

class SessionStoreImpl implements SessionStore {
  readonly db: import("better-sqlite3").Database; // shared-handle access
  constructor(path: string, opts?: SessionStoreOptions);
  // ...the full SessionStore surface from @nyx/protocol
}

interface SessionStoreOptions {
  db?: import("better-sqlite3").Database; // reuse a handle (see below)
  validate?: boolean; // debug: Zod-validate on append/read
}

class SessionStoreError extends Error {
  readonly code: "not_found" | "validation_failed" | "closed";
}

const APPROVAL_TTL_MS: number; // 10 minutes, per the protocol contract
```

## Usage

```ts
import { openSessionStore } from "@nyx/session";

const store = openSessionStore("sessions.db"); // or ":memory:"
const meta = await store.create({ owner_id: "op-1", persona_id: "nyx", title: "daily" });

await store.append(meta.session_id, [
  { type: "turn.started", session_id: meta.session_id, turn_id: "t1", ts: Date.now() },
  {
    type: "message.user",
    session_id: meta.session_id,
    turn_id: "t1",
    content: [{ type: "text", text: "status?" }],
    ts: Date.now(),
  },
]);

for await (const ev of store.stream(meta.session_id)) {
  console.log(ev.seq, ev.type);
  break; // stops cleanly; the store only polls while you await
}

const projection = await store.projection(meta.session_id);
console.log(projection.messages, projection.usage);

await store.rebuildProjections(); // replay: tables come back byte-identical
store.close();
```

## Design notes / invariants

- **Event log is the truth.** Every `append` is one transaction: insert each
  event with a store-assigned seq, update `sessions.updated_at`, and maintain
  the projection tables _in the same transaction_. Nothing else writes
  `messages`/`tool_calls`/`approvals`.
- **Seq semantics.** `events.seq` is the table's `INTEGER PRIMARY KEY
AUTOINCREMENT` — a single _global_, monotonic, never-reused sequence across
  all sessions (per-session reads are ordered by seq; under interleaved
  appends a session's seqs are strictly increasing but not contiguous). A
  fresh store's first `session.created` lands on seq 1.
- **Payload canonicalization.** `payload_json` is the canonical JSON
  (protocol `canonicalJson`: sorted keys, `undefined` dropped) of the whole
  event _minus seq_ — `type` is additionally extracted into its own column
  for indexed scans. Reads return `{ ...payload, seq }`, so replay reproduces
  byte-identical values.
- **Replay determinism.** All projection rows are pure functions of
  (event payload, seq): row ids are `${session_id}:${seq|call_id|approval_id}`
  and timestamps come from events, never from clocks. `rebuildProjections()`
  truncates the projection tables and replays the log in global seq order —
  the result is byte-identical to the incremental state (verified by tests up
  to 10k events). The composite row ids also keep a fork's re-appended events
  from colliding with the parent's rows.
- **Fork.** `fork(sid, at_seq)` copies events with `seq <= at_seq` into a new
  session under fresh global seqs; only the payload's `session_id` is
  rewritten to the child (everything else is identical), the child's metadata
  (owner, persona, engagement) is copied with `title + " (fork)"`, and a
  `session.forked` event is appended to the parent.
- **Projections.** `message.user`/`message.assistant` → `messages` rows
  (deltas do not); `tool.call` → `pending`, `tool.result` → `ok` (+ output),
  `tool.error` → `error`, `action.denied` → `denied`;
  `approval.requested` inserts an approvals row (expires_at = event ts +
  10 min), `approval.resolved` sets decision/decided_by. `usage` is summed
  from `turn.completed` events with the protocol `mergeUsage` helper at read
  time. `projection_version.last_seq` tracks each session's applied horizon.
- **Stream.** Pull-driven async iterator: it replays from `from_seq`
  (inclusive — `session.created` included when starting at 0), then polls
  every 25 ms. Because generators are pull-based, polling happens only while
  the consumer awaits the next value (inherent backpressure), and `break`
  suspends the generator for good.
- **Sharing the database.** Pass `opts.db` (or use `store.db`) so another
  package (e.g. `@nyx/policy`) can share one better-sqlite3 handle. Migrations
  run idempotently on open; `close()` never closes a handle it did not
  create. Note for such packages: approvals rows created by the policy engine
  are upserted (event wins) when the matching `approval.requested` event is
  projected, so replay stays deterministic.
- **Migrations.** Handwritten, ordered `.sql` files in `drizzle/` (currently
  `0000_init.sql`), applied by an internal `migrate(db)` that records applied
  files in `_migrations`. The DDL is a cross-package contract — other packages
  read these tables directly.
- **Debug validation.** `openSessionStore(path, { validate: true })` runs the
  protocol Zod schemas (`SessionEventSchema`/`StoredEventSchema`) on append and
  read. Off by default: the hot path never touches zod.
- **Errors.** `SessionStoreError` with `code` of `not_found`, `validation_failed`
  or `closed`. `projection()` on an unknown session throws `not_found` (the
  protocol return type has no null case).

## Tables created (see `drizzle/0000_init.sql`)

`sessions`, `events`, `messages`, `tool_calls`, `approvals`,
`projection_version` — actively used in Phase 0. `memories`, `tasks`, `audit`,
`personas`, `models` — created per the NYX data model for the packages that
will own them, but not written by this package yet.

## Intentionally deferred

- No log compaction/retention (compaction events are recorded, never applied).
- `memories`/`tasks`/`audit`/`personas`/`models` access belongs to their own
  packages; this one only creates the tables.
- Single-process, single-writer usage; `busy_timeout` is set but no
  cross-process coordination is provided.
- `metadata_json` on sessions is reserved (never written by the store).
