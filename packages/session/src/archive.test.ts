// SPDX-License-Identifier: AGPL-3.0-or-later
// Store-level archive contracts (Phase 4 §3): the archivePath option, the
// read() fallback for retention-archived sessions, the "archived" refusal
// for appends/forks (a log must never split across databases), and the
// loud error when an archived session is read through a store that has no
// archive attached.

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openSessionStore, archivePathOf } from "./index.js";
import type { SessionStore } from "@nyx/protocol";

interface Stack {
  db: Database.Database;
  store: SessionStore;
  close(): void;
}

const stacks: Stack[] = [];

function makeStack(archivePath?: string): Stack {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  const store = openSessionStore(":memory:", {
    db,
    ...(archivePath !== undefined ? { archivePath } : {}),
  });
  const stack: Stack = {
    db,
    store,
    close: () => {
      store.close();
      db.close();
    },
  };
  stacks.push(stack);
  return stack;
}

afterAll(() => {
  while (stacks.length > 0) stacks.pop()!.close();
});

/** Simulate the retention move at the SQL level (the real pass lives in
 * @nyx/tasks — here we only exercise the STORE's side of the contract). */
function archiveViaSql(s: Stack, session_id: string, now: number): void {
  s.db
    .prepare(
      `INSERT OR REPLACE INTO archive.events (seq, session_id, type, payload_json, ts)
       SELECT seq, session_id, type, payload_json, ts FROM events WHERE session_id = ?`,
    )
    .run(session_id);
  const txn = s.db.transaction(() => {
    s.db.prepare("DELETE FROM events WHERE session_id = ?").run(session_id);
    s.db
      .prepare("UPDATE sessions SET archived = 1, archived_at = ? WHERE id = ?")
      .run(now, session_id);
  });
  txn();
}

describe("archivePathOf", () => {
  it("derives the sibling archive path", () => {
    expect(archivePathOf("/var/lib/nyx/nyx.db")).toBe("/var/lib/nyx/nyx-archive.db");
    expect(archivePathOf("nyx.db")).toBe("nyx-archive.db");
    expect(archivePathOf("C:\\data\\nyx.db")).toBe("C:\\data\\nyx-archive.db");
  });
});

describe("a store WITH the archive attached", () => {
  it("serves reads of an archived session from the archive and refuses appends/forks", async () => {
    const s = makeStack(":memory:");
    const meta = await s.store.create({ owner_id: "o", persona_id: "p", kind: "subagent" });
    await s.store.append(meta.session_id, [
      {
        type: "subagent.completed",
        session_id: meta.session_id,
        subagent_session_id: meta.session_id,
        parent_session_id: "none",
        summary: "done",
        tokens_used: 1,
        duration_ms: 1,
        ts: 1,
      },
    ]);
    const before = await s.store.read(meta.session_id);
    expect(before).toHaveLength(2);

    archiveViaSql(s, meta.session_id, 42);

    // Reads serve the SAME events (same seqs) from the archive.
    const after = await s.store.read(meta.session_id);
    expect(after.map((e) => e.seq)).toEqual(before.map((e) => e.seq));
    expect(after.map((e) => e.type)).toEqual(before.map((e) => e.type));
    // Windows still work against the archive.
    expect((await s.store.read(meta.session_id, before[1]!.seq)).map((e) => e.type)).toEqual([
      "subagent.completed",
    ]);

    // meta stays resolvable; list hides it.
    expect((await s.store.meta(meta.session_id))!.archived_at).toBe(42);
    expect((await s.store.list({})).find((m) => m.session_id === meta.session_id)).toBeUndefined();

    // Immutability: appends and forks are refused with the typed error.
    await expect(
      s.store.append(meta.session_id, [
        {
          type: "subagent.aborted",
          session_id: meta.session_id,
          subagent_session_id: meta.session_id,
          parent_session_id: "none",
          reason: "late",
          ts: 2,
        },
      ]),
    ).rejects.toMatchObject({ code: "archived" });
    await expect(s.store.fork(meta.session_id, 1)).rejects.toMatchObject({ code: "archived" });
  });
});

describe("a store WITHOUT the archive attached", () => {
  it("reads an archived session as a loud misconfiguration, never a silent empty log", async () => {
    const s = makeStack(); // no archivePath
    const meta = await s.store.create({ owner_id: "o", persona_id: "p", kind: "subagent" });
    // The events were moved by ANOTHER process (its archive, its handle).
    s.db.prepare("DELETE FROM events WHERE session_id = ?").run(meta.session_id);
    s.db
      .prepare("UPDATE sessions SET archived = 1, archived_at = 1 WHERE id = ?")
      .run(meta.session_id);

    expect((await s.store.meta(meta.session_id))!.archived_at).toBe(1); // meta still fine
    await expect(s.store.read(meta.session_id)).rejects.toMatchObject({ code: "archived" });

    // Live sessions are unaffected by the missing archive.
    const live = await s.store.create({ owner_id: "o", persona_id: "p" });
    expect((await s.store.read(live.session_id)).length).toBe(1);
  });
});
