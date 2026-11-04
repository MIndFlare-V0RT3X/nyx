// SPDX-License-Identifier: AGPL-3.0-or-later
// The unified database (2.0.1). One SQLite file — nyx.db — owns every table:
// the session event log and its projections, the approval engine and the
// hash-chained audit log, channel session mappings, and heartbeat state.
// One connection, WAL, synchronous=FULL, busy_timeout 5000.
//
// Split-DB migration: Phase 0/1 laid out four files (nyx.db + policy.db +
// channels.db + heartbeat.db). On open, any legacy file present in the data
// dir is migrated into nyx.db inside ONE transaction:
//   - audit rows copy with id, prev_hash linkage, and every column
//     (including the Phase 1 event_seq addition) preserved;
//   - the chain is verified in-transaction BEFORE commit: the last hash in
//     the new table must equal the last hash of the old file, and the whole
//     chain must re-verify — otherwise the migration aborts and the old
//     files stay untouched;
//   - a `db.migrated` audit row is appended as the first row the unified
//     database itself writes, hash-chained onto the previous head;
//   - after commit, each legacy file is renamed to `<name>.migrated-<ts>`
//     in the same directory — never deleted.
//
// The engine's approval table is `policy_approvals` in the unified file: the
// name `approvals` there is the session store's rebuildable projection.

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "@nyx/protocol";
import { appendAudit, ensureApprovalEngineTables, verifyAuditChain } from "@nyx/policy";
import { migrate as migrateSessionStore } from "@nyx/session";
import { ensureChannelSessionsTable } from "@nyx/channels";
import { ensureHeartbeatTables } from "@nyx/runtime";

/** Legacy split-DB file names (Phase 0/1 layout), next to nyx.db. */
export const LEGACY_DB_FILES = ["policy.db", "channels.db", "heartbeat.db"] as const;

export interface UnifiedDbOptions {
  logger?: Logger;
  now?: () => number;
}

export interface UnifiedDb {
  /** The one shared better-sqlite3 handle every store runs on. */
  db: Database.Database;
  /** Absolute paths of legacy files renamed by the migration (empty when none ran). */
  migratedLegacyFiles: string[];
  close(): void;
}

interface TableNamesRow {
  name: string;
}

interface CountRow {
  n: number;
}

function tableNames(db: Database.Database, schema: string): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as TableNamesRow[]
    ).map((r) => r.name),
  );
}

function countOf(db: Database.Database, schema: string, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${table}`).get() as CountRow;
  return row.n;
}

/** Quote a path for use in ATTACH (single quotes doubled). */
function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function openUnifiedDatabase(nyxDbPath: string, opts: UnifiedDbOptions = {}): UnifiedDb {
  const now = opts.now ?? Date.now;
  const log = opts.logger;
  mkdirSync(dirname(nyxDbPath), { recursive: true });

  const legacyPaths = LEGACY_DB_FILES.map((name) => join(dirname(nyxDbPath), name)).filter((p) =>
    existsSync(p),
  );
  const freshNyxDb = !existsSync(nyxDbPath);

  const db = new Database(nyxDbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("synchronous = FULL");
    db.pragma("busy_timeout = 5000");

    // Ensure every owner's tables exist on this handle (all idempotent):
    // session store (sessions/events/projections/…), policy engine
    // (policy_approvals + audit with event_seq), channels, heartbeat.
    migrateSessionStore(db);
    ensureApprovalEngineTables(db);
    ensureChannelSessionsTable(db);
    ensureHeartbeatTables(db);

    if (legacyPaths.length === 0) {
      return { db, migratedLegacyFiles: [], close: () => db.close() };
    }

    const migrated = migrateSplitLayout(db, nyxDbPath, legacyPaths, { log, now });
    log?.info("db.migrated", {
      unified: nyxDbPath,
      legacy_files: migrated.renamed.map((p) => basename(p)),
      rows: migrated.rows,
    });
    return {
      db,
      migratedLegacyFiles: migrated.renamed,
      close: () => db.close(),
    };
  } catch (err) {
    db.close();
    // A migration abort on a file we created this call must not leave a stray
    // nyx.db behind: the next start would see a "unified" file with no data.
    if (freshNyxDb && existsSync(nyxDbPath)) {
      try {
        unlinkSync(nyxDbPath);
      } catch {
        // best effort — the thrown error names the state anyway
      }
    }
    throw err;
  }
}

interface MigrationResult {
  rows: Record<string, number>;
}

function migrateSplitLayout(
  db: Database.Database,
  nyxDbPath: string,
  legacyPaths: string[],
  opts: { log?: Logger; now: () => number },
): { renamed: string[]; rows: Record<string, number> } {
  const attached: string[] = [];
  // ATTACH must happen outside any transaction (SQLite restriction). The
  // legacy files are opened read-intent: nothing in this migration ever
  // writes to them, and a rollback leaves them byte-identical.
  for (const path of legacyPaths) {
    const schema = `old_${basename(path).replaceAll(".", "_")}`;
    db.exec(`ATTACH DATABASE ${sqlString(path)} AS ${schema}`);
    attached.push(schema);
  }

  const txn = db.transaction((): MigrationResult => {
    const rows: Record<string, number> = {};

    // ── audit chain (policy.db) ──
    const policySchema = attached.find((s) => s.startsWith("old_policy_db"));
    if (policySchema !== undefined && tableNames(db, policySchema).has("audit")) {
      const oldCount = countOf(db, policySchema, "audit");
      const newCount = countOf(db, "main", "audit");
      if (oldCount > 0 && newCount > 0) {
        throw new Error(
          `refusing to migrate: ${nyxDbPath} already has ${newCount} audit rows and the legacy ` +
            `policy.db has ${oldCount} — two chains cannot be merged; resolve manually ` +
            "(move or rename one of the files)",
        );
      }
      if (oldCount > 0) {
        db.exec(
          `INSERT INTO main.audit (id, prev_hash, hash, actor, action, payload_json, created_at, event_seq)
           SELECT id, prev_hash, hash, actor, action, payload_json, created_at, event_seq
           FROM ${policySchema}.audit ORDER BY id`,
        );
        // In-transaction verification BEFORE commit (hard rule #3): the
        // whole chain must re-verify and the head must match the old file.
        const verification = verifyAuditChain(db);
        if (!verification.ok) {
          throw new Error(
            `migration aborted: audit chain verification failed at row ${verification.first_bad_id ?? "?"} after copy`,
          );
        }
        const oldHead = (
          db.prepare(`SELECT hash FROM ${policySchema}.audit ORDER BY id DESC LIMIT 1`).get() as {
            hash: string;
          }
        ).hash;
        const newHead = (
          db.prepare("SELECT hash FROM main.audit ORDER BY id DESC LIMIT 1").get() as {
            hash: string;
          }
        ).hash;
        if (oldHead !== newHead) {
          throw new Error(
            "migration aborted: audit chain head mismatch after copy " +
              `(${newHead.slice(0, 12)}… != ${oldHead.slice(0, 12)}…)`,
          );
        }
      }
      rows.audit = oldCount;

      // ── approval engine rows (policy.approvals → main.policy_approvals) ──
      if (tableNames(db, policySchema).has("approvals")) {
        const n = countOf(db, policySchema, "approvals");
        if (n > 0) {
          db.exec(
            `INSERT OR REPLACE INTO main.policy_approvals
               (id, session_id, turn_id, action_digest, summary, risk, decision, decided_by, created_at, expires_at, used_at)
             SELECT id, session_id, turn_id, action_digest, summary, risk, decision, decided_by, created_at, expires_at, used_at
             FROM ${policySchema}.approvals`,
          );
        }
        rows.policy_approvals = n;
      }
    }

    // ── channel session mappings (channels.db) ──
    const channelsSchema = attached.find((s) => s.startsWith("old_channels_db"));
    if (channelsSchema !== undefined && tableNames(db, channelsSchema).has("channel_sessions")) {
      const n = countOf(db, channelsSchema, "channel_sessions");
      if (n > 0) {
        db.exec(
          `INSERT OR REPLACE INTO main.channel_sessions
             SELECT channel_key, channel, channel_user_id, thread_id, session_id, updated_at
           FROM ${channelsSchema}.channel_sessions`,
        );
      }
      rows.channel_sessions = n;
    }

    // ── heartbeat state (heartbeat.db) ──
    const hbSchema = attached.find((s) => s.startsWith("old_heartbeat_db"));
    if (hbSchema !== undefined && tableNames(db, hbSchema).has("heartbeat_state")) {
      const state = countOf(db, hbSchema, "heartbeat_state");
      if (state > 0) {
        db.exec(
          `INSERT OR REPLACE INTO main.heartbeat_state (spec_id, last_fired_at, next_fire_at)
           SELECT spec_id, last_fired_at, next_fire_at FROM ${hbSchema}.heartbeat_state`,
        );
      }
      rows.heartbeat_state = state;
      if (tableNames(db, hbSchema).has("heartbeat_history")) {
        const hist = countOf(db, hbSchema, "heartbeat_history");
        if (hist > 0) {
          db.exec(
            `INSERT INTO main.heartbeat_history (spec_id, fired_at, status, source)
             SELECT spec_id, fired_at, status, source FROM ${hbSchema}.heartbeat_history`,
          );
        }
        rows.heartbeat_history = hist;
      }
    }

    // The first row the unified database writes for itself: hash-chained onto
    // the migrated head (or the genesis empty chain), inside the same txn.
    appendAudit(db, {
      actor: "system:db",
      action: "db.migrated",
      payload: {
        unified: nyxDbPath,
        legacy_files: legacyPaths.map((p) => basename(p)),
        rows,
      },
    });

    return { rows };
  });

  let result: MigrationResult;
  try {
    result = txn.immediate();
  } catch (err) {
    // Rollback happened: detach and leave every original file intact.
    for (const schema of attached) {
      try {
        db.exec(`DETACH DATABASE ${schema}`);
      } catch {
        // already rolled back / detached
      }
    }
    throw err;
  }

  for (const schema of attached) db.exec(`DETACH DATABASE ${schema}`);

  // Committed. Rename the legacy files (same directory, never deleted).
  const stamp = String(opts.now());
  const renamed: string[] = [];
  for (const path of legacyPaths) {
    const target = `${path}.migrated-${stamp}`;
    renameSync(path, target);
    renamed.push(target);
    opts.log?.info("db.legacy_renamed", { from: path, to: target });
  }
  return { renamed, rows: result.rows };
}
