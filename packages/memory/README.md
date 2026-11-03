# @nyx/memory

Markdown-backed memory store for NYX. Every memory is a human-editable
markdown file under `<root>/<scope>/<id>.md` (scope ∈ `session` | `persona` |
`owner` | `global`); an SQLite index at `<root>/index.sqlite` (with an FTS5
virtual table) makes them searchable. **The file is the source of truth; the
index is a rebuildable mirror.** Phase 0 retrieval is lexical (FTS5/BM25 with
a tag boost); the embedding path exists only as a seam.

## Public exports

```ts
class MemoryStoreImpl implements MemoryStore {
  constructor(rootDir: string, opts?: {
    episode_expiry_days?: number; // default 30
    embedder?: Embedder;          // Phase 0 seam, not consumed by search
  })
  write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry>
  search(query: string, opts?: MemorySearchOptions): Promise<Array<MemoryEntry & { score: number }>>
  get(id: string): Promise<MemoryEntry | null>
  list(opts?: { scope?: MemoryScope[]; kind?: MemoryEntry["kind"]; limit?: number }): Promise<MemoryEntry[]>
  compact(): Promise<{ merged: number; dropped: number }>
  close(): void
}

class NoopEmbedder implements Embedder { embed(text: string): Promise<number[]> } // → []
class MemoryValidationError extends Error { code: "validation_failed" }
function sanitizeFtsQuery(query: string): string
```

`MemoryEntry`, `MemoryStore`, `MemorySearchOptions`, `MemoryScope`, and
`Embedder` are re-exported from `@nyx/protocol`.

## Usage

```ts
import { MemoryStoreImpl } from "@nyx/memory";

const store = new MemoryStoreImpl("/home/op/.local/share/nyx/memory");
const fact = await store.write({
  scope: "persona",
  kind: "fact",
  content: "primary db runs postgres 16 with streaming replication",
  tags: ["database", "infra"],
  source: { session_id: "sess-42" },
});
const hits = await store.search("postgres", { scope: ["persona"], limit: 10 });
const merged = await store.compact(); // { merged: 0, dropped: 3 }
```

## File format

```markdown
---
id: V1StGXR8_Z5jdHi6B-myT
scope: persona
kind: fact
tags: [database, infra]
source:
  session_id: sess-42
created_at: 1700000000000
updated_at: 1700000000000
---
primary db runs postgres 16 with streaming replication
```

Frontmatter is parsed with the `yaml` package. Malformed frontmatter — bad
YAML, missing required keys, wrong types, bad scope/kind enums — throws
`MemoryValidationError` (`code: "validation_failed"`) whose message names the
file path and, when a line number is known, the file line (parser-supplied
lines are rebased to file coordinates: the frontmatter block starts on file
line 2). CRLF input is normalized to LF on parse.

## Design notes / invariants

- **File-first writes.** `write` creates the file, then inserts the index row
  and the FTS row inside a transaction. Updates to an existing id (drift
  refresh) delete + re-insert the FTS row so stale tokens never accumulate.
- **Lazy reindex on read mismatch.** `get` always parses the file; if the
  indexed row disagrees — stat (mtime + size) or any field differs — the row
  is refreshed from the file. `search` checks its candidate rows the same way
  and re-runs the query once if anything drifted, so hand-edited files
  converge without a manual rebuild. A file that fails validation after a
  hand edit is dropped from the index instead of crashing the search.
  `list` reads the index only (it is the cheap path); `get` is the
  source-of-truth path.
- **Index recovery.** If the index is lost but files remain, `get` scans the
  scope directories for `<id>.md` and rebuilds the row on demand.
- **FTS injection safety.** Queries are sanitized before `MATCH`: split on
  whitespace, internal double quotes doubled (the FTS5 string escape), each
  term wrapped in double quotes, terms ANDed. `query)`, `foo"bar`, `NEAR(a b)`
  all become inert phrase tokens.
- **Scoring.** `score = -rank` (bm25; better match = lower rank). If any query
  term appears (case-insensitive containment) in an entry's tags, the score is
  multiplied by 1.5. Results are sorted by score desc, filtered by
  `min_score`, capped at `limit` (default 20). Note that the FTS index covers
  the tags column too, so a tag term also raises the base bm25 — the 1.5x
  multiplier is on top of that.
- **compact().** (a) Duplicate facts — same scope, kind `fact`, normalized
  content (lowercase, whitespace collapsed, trailing punctuation stripped) —
  are merged into the entry with the newest `updated_at` (deterministic
  tie-break on id); tags are unioned (keeper's order first), the losers'
  files and rows are deleted. (b) Episodes older than `episode_expiry_days`
  (by `created_at`) are moved to `<root>/expired/<scope>/` and removed from
  the index; they are no longer reachable via `get`/`search`/`list`.
- **Id safety.** Ids are nanoid-generated; `get` rejects ids that are not
  `[A-Za-z0-9_-]{1,64}` (no path traversal through the store).

## Limitations (known, accepted)

- A memory body containing a line that is exactly `---` would terminate the
  frontmatter early and fail validation. Don't write horizontal rules as the
  first body line of a memory.
- `compact` groups duplicates on *indexed* content; a file hand-edited after
  indexing without any intervening read participates in grouping with its
  stale content (the survivor selection still refreshes through `get`).

## Intentionally deferred

- Vector retrieval: the `Embedder` seam is accepted by the constructor but
  not consumed by `search` (Phase 0 is lexical only; `NoopEmbedder` is the
  default).
- Appending a human-readable line per write to the persona's `MEMORY.md`
  mirror (the assistant can read the files directly today).
- Cross-scope deduplication, embedding-based near-duplicate merging, and
  episode summarization before expiry.
