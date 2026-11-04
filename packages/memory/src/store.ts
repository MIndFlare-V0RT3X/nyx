// SPDX-License-Identifier: AGPL-3.0-or-later
// Markdown-backed memory store with an SQLite (FTS5/BM25) index.
//
// Invariant: the markdown file is the source of truth, the index is a mirror.
// Writes go file-first then index. Reads that must reflect the file (get) or
// join the index (search) detect drift by comparing the file's stat
// (mtime + size) and parsed fields against the indexed row, and lazily
// reindex on mismatch. Hand-edited files therefore converge without a manual
// rebuild. `list` reads the index only.

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import type {
  Embedder,
  MemoryEntry,
  MemoryScope,
  MemorySearchOptions,
  MemoryStore,
} from "@nyx/protocol";
import { MemoryValidationError, entryToMarkdown, parseMemoryFile } from "./frontmatter.js";

export interface MemoryStoreOptions {
  /** Episodes older than this (by created_at) are archived by compact(). Default 30. */
  episode_expiry_days?: number;
  /**
   * Seam for vector retrieval. Not consumed in Phase 0 — search is lexical —
   * but accepted so later phases can inject an embedder without a
   * constructor break.
   */
  embedder?: Embedder;
}

interface MemoryRow {
  id: string;
  scope: string;
  kind: string;
  content: string;
  tags_json: string;
  source_json: string;
  created_at: number;
  updated_at: number;
  path: string;
  mtime_ms: number;
  size: number;
}

interface RowWithRank extends MemoryRow {
  rank: number;
}

const SCOPES: readonly MemoryScope[] = ["session", "persona", "owner", "global"];
const KINDS: readonly MemoryEntry["kind"][] = [
  "fact",
  "preference",
  "procedure",
  "episode",
  "skill-note",
];
const DAY_MS = 24 * 60 * 60 * 1000;

export class MemoryStoreImpl implements MemoryStore {
  private readonly db: Database.Database;
  private readonly root: string;
  private readonly episodeExpiryDays: number;
  private readonly embedder: Embedder | undefined;

  constructor(rootDir: string, opts: MemoryStoreOptions = {}) {
    this.root = path.resolve(rootDir);
    this.episodeExpiryDays = opts.episode_expiry_days ?? 30;
    this.embedder = opts.embedder;
    fs.mkdirSync(this.root, { recursive: true });
    this.db = new Database(path.join(this.root, "index.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        source_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        path TEXT NOT NULL,
        mtime_ms REAL NOT NULL,
        size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memories_scope_kind ON memories(scope, kind);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags);
    `);
  }

  /** Close the SQLite handle. Files stay on disk untouched. */
  close(): void {
    this.db.close();
  }

  async write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry> {
    if (!SCOPES.includes(entry.scope)) {
      throw new MemoryValidationError(
        `write: scope must be one of ${SCOPES.join("|")}, got ${JSON.stringify(entry.scope)}`,
      );
    }
    if (!KINDS.includes(entry.kind)) {
      throw new MemoryValidationError(
        `write: kind must be one of ${KINDS.join("|")}, got ${JSON.stringify(entry.kind)}`,
      );
    }
    if (typeof entry.content !== "string") {
      throw new MemoryValidationError("write: content must be a string");
    }
    if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== "string")) {
      throw new MemoryValidationError("write: tags must be an array of strings");
    }
    if (typeof entry.source !== "object" || entry.source === null || Array.isArray(entry.source)) {
      throw new MemoryValidationError("write: source must be an object");
    }
    const now = Date.now();
    const full: MemoryEntry = {
      id: nanoid(),
      scope: entry.scope,
      kind: entry.kind,
      content: entry.content,
      source: { ...entry.source },
      tags: [...entry.tags],
      created_at: now,
      updated_at: now,
    };
    const file = this.filePathFor(full.scope, full.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entryToMarkdown(full), "utf8");
    this.indexRow(full, file);
    return full;
  }

  async search(
    query: string,
    opts: MemorySearchOptions = {},
  ): Promise<Array<MemoryEntry & { score: number }>> {
    const match = sanitizeFtsQuery(query);
    if (match === "") return [];
    const limit = opts.limit ?? 20;
    const terms = query
      .split(/\s+/)
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 0);

    let rows = this.runSearch(match, opts.scope, limit);
    // Lazy reindex: if any candidate row drifted from its file (hand edit),
    // refresh the drifted rows and run the query once more so results reflect
    // the files, not stale index content.
    if (rows.length > 0 && this.refreshDrifted(rows)) {
      rows = this.runSearch(match, opts.scope, limit);
    }

    const results: Array<MemoryEntry & { score: number }> = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      let score = -row.rank; // bm25: better match = lower rank, so negate
      if (terms.some((t) => entry.tags.some((tag) => tag.toLowerCase().includes(t)))) {
        score *= 1.5; // tag boost: explicit tagging beats incidental text
      }
      if (opts.min_score !== undefined && score < opts.min_score) continue;
      results.push({ ...entry, score });
    }
    results.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return results.slice(0, limit);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    if (!isSafeFileId(id)) return null;
    const row = this.db.prepare<[string], MemoryRow>("SELECT * FROM memories WHERE id = ?").get(id);
    let file = row?.path;
    if (!file) {
      // No index row — the file may predate the index (or the index was
      // deleted). Scan the scope dirs before giving up.
      for (const scope of SCOPES) {
        const candidate = this.filePathFor(scope, id);
        if (fs.existsSync(candidate)) {
          file = candidate;
          break;
        }
      }
      if (!file) return null;
    }
    if (!fs.existsSync(file)) {
      // File gone (expired, deleted): the row is stale — drop it.
      if (row) this.deleteRowAndFts(id);
      return null;
    }
    const text = fs.readFileSync(file, "utf8");
    const entry = parseMemoryFile(file, text);
    if (entry.id !== id) return null; // frontmatter id must match the requested id
    if (!row || this.rowDrifted(row, entry)) {
      this.indexRow(entry, file);
    }
    return entry;
  }

  async list(
    opts: { scope?: MemoryScope[]; kind?: MemoryEntry["kind"]; limit?: number } = {},
  ): Promise<MemoryEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.scope && opts.scope.length > 0) {
      where.push(`scope IN (${opts.scope.map(() => "?").join(",")})`);
      params.push(...opts.scope);
    }
    if (opts.kind) {
      where.push("kind = ?");
      params.push(opts.kind);
    }
    const limit = opts.limit ?? 100;
    const sql = `SELECT * FROM memories ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC, id LIMIT ?`;
    params.push(limit);
    const rows = this.db.prepare<unknown[], MemoryRow>(sql).all(...params);
    return rows.map(rowToEntry);
  }

  async compact(): Promise<{ merged: number; dropped: number }> {
    let merged = 0;
    let dropped = 0;

    // (a) duplicate facts: same scope + kind "fact" + normalized content.
    // Grouped on indexed content; the survivor is the newest updated_at
    // (deterministic tie-break on id) with the union of all tags.
    const facts = this.db
      .prepare<[], MemoryRow>(
        "SELECT * FROM memories WHERE kind = 'fact' ORDER BY updated_at DESC, id",
      )
      .all();
    const groups = new Map<string, MemoryRow[]>();
    for (const row of facts) {
      const key = `${row.scope}\u0000${normalizeContent(row.content)}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      // get() refreshes drift and drops rows whose files vanished, so work
      // from the refreshed view of each duplicate.
      const alive: Array<{ entry: MemoryEntry; file: string }> = [];
      for (const row of group) {
        const entry = await this.get(row.id);
        if (entry) alive.push({ entry, file: row.path });
      }
      if (alive.length < 2) continue;
      const keeper = alive[0]!; // newest updated_at (group order preserved)
      const tags: string[] = [...keeper.entry.tags];
      for (const dup of alive.slice(1)) {
        for (const tag of dup.entry.tags) {
          if (!tags.includes(tag)) tags.push(tag);
        }
      }
      for (const dup of alive.slice(1)) {
        this.deleteRowAndFts(dup.entry.id);
        if (fs.existsSync(dup.file)) fs.rmSync(dup.file);
      }
      if (
        tags.length !== keeper.entry.tags.length ||
        tags.some((t, i) => t !== keeper.entry.tags[i])
      ) {
        const mergedEntry: MemoryEntry = { ...keeper.entry, tags };
        fs.writeFileSync(keeper.file, entryToMarkdown(mergedEntry), "utf8");
        this.indexRow(mergedEntry, keeper.file);
      }
      merged += alive.length - 1;
    }

    // (b) expired episodes: archive the file under <root>/expired/<scope>/,
    // drop the index row.
    const cutoff = Date.now() - this.episodeExpiryDays * DAY_MS;
    const episodes = this.db
      .prepare<[number], MemoryRow>(
        "SELECT * FROM memories WHERE kind = 'episode' AND created_at < ?",
      )
      .all(cutoff);
    for (const row of episodes) {
      if (fs.existsSync(row.path)) {
        const destDir = path.join(this.root, "expired", row.scope);
        fs.mkdirSync(destDir, { recursive: true });
        fs.renameSync(row.path, path.join(destDir, path.basename(row.path)));
      }
      this.deleteRowAndFts(row.id);
      dropped++;
    }
    return { merged, dropped };
  }

  // ---- internals ----

  private filePathFor(scope: MemoryScope, id: string): string {
    return path.join(this.root, scope, `${id}.md`);
  }

  /**
   * Insert-or-refresh the index row for an entry and keep the FTS mirror in
   * sync (delete + insert on update, so the index never accumulates stale
   * token rows).
   */
  private indexRow(entry: MemoryEntry, file: string): void {
    const stat = fs.statSync(file);
    const tagsJson = JSON.stringify(entry.tags);
    const sourceJson = JSON.stringify(entry.source);
    this.db.transaction(() => {
      const existing = this.db
        .prepare<[string], { rowid: number }>("SELECT rowid FROM memories WHERE id = ?")
        .get(entry.id);
      let rowid: number;
      if (existing) {
        rowid = existing.rowid;
        this.db
          .prepare(
            `UPDATE memories SET scope = ?, kind = ?, content = ?, tags_json = ?, source_json = ?,
             created_at = ?, updated_at = ?, path = ?, mtime_ms = ?, size = ? WHERE id = ?`,
          )
          .run(
            entry.scope,
            entry.kind,
            entry.content,
            tagsJson,
            sourceJson,
            entry.created_at,
            entry.updated_at,
            file,
            stat.mtimeMs,
            stat.size,
            entry.id,
          );
        this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(rowid);
      } else {
        const res = this.db
          .prepare(
            `INSERT INTO memories (id, scope, kind, content, tags_json, source_json, created_at, updated_at, path, mtime_ms, size)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            entry.id,
            entry.scope,
            entry.kind,
            entry.content,
            tagsJson,
            sourceJson,
            entry.created_at,
            entry.updated_at,
            file,
            stat.mtimeMs,
            stat.size,
          );
        rowid = Number(res.lastInsertRowid);
      }
      this.db
        .prepare("INSERT INTO memories_fts (rowid, content, tags) VALUES (?, ?, ?)")
        .run(rowid, entry.content, entry.tags.join(" "));
    })();
  }

  private deleteRowAndFts(id: string): void {
    this.db.transaction(() => {
      const row = this.db
        .prepare<[string], { rowid: number }>("SELECT rowid FROM memories WHERE id = ?")
        .get(id);
      if (!row) return;
      this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
    })();
  }

  private runSearch(
    match: string,
    scopes: MemoryScope[] | undefined,
    limit: number,
  ): RowWithRank[] {
    const where = ["memories_fts MATCH ?"];
    const params: unknown[] = [match];
    if (scopes && scopes.length > 0) {
      where.push(`memories.scope IN (${scopes.map(() => "?").join(",")})`);
      params.push(...scopes);
    }
    params.push(limit);
    const sql = `
      SELECT memories.*, memories_fts.rank AS rank
      FROM memories JOIN memories_fts ON memories.rowid = memories_fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY memories_fts.rank
      LIMIT ?`;
    return this.db.prepare<unknown[], RowWithRank>(sql).all(...params);
  }

  /**
   * True when the indexed row no longer matches the file it points at
   * (stat mismatch or field drift). Pure comparison — does not write.
   */
  private rowDrifted(row: MemoryRow, entry: MemoryEntry): boolean {
    const stat = fs.statSync(row.path);
    return (
      row.mtime_ms !== stat.mtimeMs ||
      row.size !== stat.size ||
      row.scope !== entry.scope ||
      row.kind !== entry.kind ||
      row.content !== entry.content ||
      row.tags_json !== JSON.stringify(entry.tags) ||
      row.source_json !== JSON.stringify(entry.source) ||
      row.created_at !== entry.created_at ||
      row.updated_at !== entry.updated_at
    );
  }

  /**
   * Check candidate rows for drift and reindex (or drop) the drifted ones.
   * Returns true when anything changed, so the caller can re-run its query.
   * Files that fail validation after a hand edit are dropped from the index
   * rather than crashing the search.
   */
  private refreshDrifted(rows: MemoryRow[]): boolean {
    let changed = false;
    for (const row of rows) {
      if (!fs.existsSync(row.path)) {
        this.deleteRowAndFts(row.id);
        changed = true;
        continue;
      }
      try {
        const entry = parseMemoryFile(row.path, fs.readFileSync(row.path, "utf8"));
        if (entry.id !== row.id) continue; // row belongs to a different file — leave it
        if (this.rowDrifted(row, entry)) {
          this.indexRow(entry, row.path);
          changed = true;
        }
      } catch (err) {
        if (err instanceof MemoryValidationError) {
          this.deleteRowAndFts(row.id);
          changed = true;
          continue;
        }
        throw err;
      }
    }
    return changed;
  }
}

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    scope: row.scope as MemoryScope,
    kind: row.kind as MemoryEntry["kind"],
    content: row.content,
    tags: JSON.parse(row.tags_json) as string[],
    source: JSON.parse(row.source_json) as MemoryEntry["source"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Neutralize FTS5 query syntax: split on whitespace, double internal quotes
 * (the FTS5 string escape), wrap each term in double quotes, and AND the
 * terms. Input like `query)` or `NEAR(a b)` becomes inert phrase tokens.
 * Returns "" for queries with no usable terms.
 */
export function sanitizeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

/** Duplicate detection: lowercase, collapse whitespace, strip trailing punctuation. */
function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
    .trim();
}

/** File ids are nanoid-shaped; anything else (traversal, paths) is rejected. */
function isSafeFileId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}
