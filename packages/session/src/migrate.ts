// SPDX-License-Identifier: AGPL-3.0-or-later
// Internal migration runner: applies the ordered .sql files under
// ../drizzle/ exactly once each, tracking applied files in `_migrations`.
// Idempotent — opening the same database repeatedly is safe, which is what
// lets other packages share a handle via openSessionStore(path, { db }).

import type Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Works both from src (vitest) and from dist (tsc output): both sit one
// directory below packages/session, and ../drizzle is a sibling.
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

interface MigrationRow {
  name: string;
}

export function migrate(db: Database.Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as MigrationRow[]).map((r) => r.name),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // zero-padded names make lexicographic order the apply order
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, Date.now());
    });
    apply();
  }
}
