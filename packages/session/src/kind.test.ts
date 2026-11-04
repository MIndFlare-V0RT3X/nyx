// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 3 (§2.7): the sessions.kind migration and archive semantics.
//   - 0001_sessions_kind.sql adds kind (CHECK in session|fork|subagent,
//     default 'session') and archived_at to every existing database;
//   - existing rows become 'session', new forks become 'fork',
//     subagent sessions are created with kind 'subagent';
//   - list() filters by kinds and hides archived sessions;
//   - archiveSession() marks (never deletes) a subagent session.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openSessionStore } from "./store.js";
import type { SessionStore } from "@nyx/protocol";

const dirs: string[] = [];
const stores: SessionStore[] = [];

function tmpStore(): SessionStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nyx-kind-test-"));
  dirs.push(dir);
  const store = openSessionStore(path.join(dir, "nyx.db"));
  stores.push(store);
  return store;
}

afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("sessions.kind migration (0001)", () => {
  it("adds kind + archived_at to a pre-Phase-3 database, existing rows = 'session'", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "nyx-kind-migrate-"));
    dirs.push(dir);
    const dbPath = path.join(dir, "nyx.db");

    // A Phase-0/1/2 database: sessions table WITHOUT kind/archived_at.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, parent_id TEXT, owner_id TEXT NOT NULL,
        persona_id TEXT NOT NULL, title TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        engagement_json TEXT, metadata_json TEXT
      );
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL, payload_json TEXT NOT NULL, ts INTEGER NOT NULL
      );
      INSERT INTO sessions (id, owner_id, persona_id, title, created_at, updated_at)
        VALUES ('legacy-1', 'owner', 'p', 'old', 1, 1);
    `);
    legacy.close();

    // Opening runs the migration runner: 0000 is a no-op (IF NOT EXISTS),
    // 0001 adds the columns. The legacy row must read back as kind 'session'.
    const store = openSessionStore(dbPath);
    stores.push(store);
    const meta = await store.meta("legacy-1");
    expect(meta?.kind).toBe("session");
    expect(meta?.archived_at).toBeNull();
    // The CHECK constraint is live: only the three lineages fit.
    const raw = new Database(dbPath);
    expect(() =>
      raw
        .prepare(
          `INSERT INTO sessions (id, owner_id, persona_id, title, created_at, updated_at, kind)
           VALUES ('bad', 'o', 'p', '', 1, 1, 'daemon')`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);
    raw.close();
  });

  it("creates sessions with kind 'subagent' and forks with kind 'fork'", async () => {
    const store = tmpStore();
    const root = await store.create({ owner_id: "owner", persona_id: "p" });
    expect(root.kind).toBe("session");

    const child = await store.create({
      owner_id: "owner",
      persona_id: "p",
      parent_id: root.session_id,
      kind: "subagent",
    });
    expect(child.kind).toBe("subagent");
    expect(child.parent_id).toBe(root.session_id);

    const fork = await store.fork(root.session_id, 1);
    expect(fork.kind).toBe("fork");
    expect(fork.parent_id).toBe(root.session_id);

    await expect(
      store.create({ owner_id: "owner", persona_id: "p", kind: "weird" as never }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("list() filters by kinds and hides archived sessions", async () => {
    const store = tmpStore();
    const root = await store.create({ owner_id: "owner", persona_id: "p" });
    await store.create({
      owner_id: "owner",
      persona_id: "p",
      parent_id: root.session_id,
      kind: "subagent",
    });
    await store.fork(root.session_id, 1);

    const all = await store.list({ limit: 10 });
    expect(all.map((m) => m.kind).sort()).toEqual(["fork", "session", "subagent"]);

    const noSubagents = await store.list({ limit: 10, kinds: ["session", "fork"] });
    expect(noSubagents.map((m) => m.kind)).toEqual(["fork", "session"]);

    const onlySubagents = await store.list({ limit: 10, kinds: ["subagent"] });
    expect(onlySubagents.map((m) => m.kind)).toEqual(["subagent"]);

    // Archive the subagent: hidden from the default list, resolvable via meta.
    const sub = onlySubagents[0]!;
    const archived = await store.archiveSession(sub.session_id);
    expect(archived.archived_at).not.toBeNull();
    expect((await store.list({ limit: 10 })).map((m) => m.session_id)).not.toContain(
      sub.session_id,
    );
    expect((await store.list({ limit: 10, include_archived: true })).length).toBe(3);
    expect((await store.meta(sub.session_id))?.session_id).toBe(sub.session_id);
    // Idempotent.
    expect((await store.archiveSession(sub.session_id)).archived_at).not.toBeNull();
    // Events are still there — nothing was deleted.
    expect((await store.read(sub.session_id)).length).toBeGreaterThan(0);
  });

  it("refuses to archive non-subagent sessions", async () => {
    const store = tmpStore();
    const root = await store.create({ owner_id: "owner", persona_id: "p" });
    await expect(store.archiveSession(root.session_id)).rejects.toMatchObject({
      code: "validation_failed",
    });
  });
});
