// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Engagement, SessionEvent } from "@nyx/protocol";
import { SessionStoreError, SessionStoreImpl } from "./store.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function memoryStore(opts?: ConstructorParameters<typeof SessionStoreImpl>[1]): SessionStoreImpl {
  return new SessionStoreImpl(":memory:", opts);
}

async function fileStore(
  opts?: ConstructorParameters<typeof SessionStoreImpl>[1],
): Promise<SessionStoreImpl> {
  const dir = await mkdtemp(join(tmpdir(), "nyx-session-store-"));
  tmpDirs.push(dir);
  return new SessionStoreImpl(join(dir, "store.db"), opts);
}

let ts = 1_000_000;
const nextTs = (): number => (ts += 1);

function userMsg(sid: string, turn: string, text: string): SessionEvent {
  return {
    type: "message.user",
    session_id: sid,
    turn_id: turn,
    content: [{ type: "text", text }],
    ts: nextTs(),
  };
}

function assistantMsg(sid: string, turn: string, text: string): SessionEvent {
  return {
    type: "message.assistant",
    session_id: sid,
    turn_id: turn,
    content: [{ type: "text", text }],
    ts: nextTs(),
  };
}

const engagement: Engagement = {
  id: "ENG-2026-042",
  title: "Test engagement",
  operator_id: "owner-1",
  authorized_at: 1000,
  expires_at: 2000,
  targets: { cidrs: ["10.0.0.0/8"], domains: ["example.com"], ports: { deny: [25] } },
  rules: ["no production systems"],
};

describe("create", () => {
  it("returns meta and appends session.created as the first event", async () => {
    const store = memoryStore();
    const meta = await store.create({
      owner_id: "owner-1",
      persona_id: "persona-a",
      title: "First",
    });
    expect(meta.session_id).toMatch(/^[A-Za-z0-9_-]{21}$/); // nanoid
    expect(meta.parent_id).toBeNull();
    expect(meta.owner_id).toBe("owner-1");
    expect(meta.persona_id).toBe("persona-a");
    expect(meta.title).toBe("First");
    expect(meta.created_at).toBeGreaterThan(0);
    expect(meta.updated_at).toBe(meta.created_at);

    const events = await store.read(meta.session_id);
    expect(events).toHaveLength(1);
    expect(events[0]?.seq).toBe(1); // fresh store: session.created lands on seq 1
    expect(events[0]?.type).toBe("session.created");
    const created = events[0] as Extract<SessionEvent, { type: "session.created" }>;
    expect(created.engagement).toBeNull(); // null explicit, not undefined
    expect("engagement" in created).toBe(true);
    expect(created.owner_id).toBe("owner-1");
    expect(created.parent_id).toBeNull();
    store.close();
  });

  it("round-trips engagement deep-equal and defaults to null", async () => {
    const store = memoryStore();
    const withEng = await store.create({ owner_id: "o", persona_id: "p", engagement });
    expect(withEng.engagement).toEqual(engagement);
    expect(await store.meta(withEng.session_id)).toEqual(withEng);

    const withoutEng = await store.create({ owner_id: "o", persona_id: "p" });
    expect(withoutEng.engagement).toBeNull();
    const events = await store.read(withoutEng.session_id);
    const created = events[0] as Extract<SessionEvent, { type: "session.created" }>;
    expect(created.engagement).toBeNull();
    store.close();
  });

  it("stores parent_id and empty title default", async () => {
    const store = memoryStore();
    const parent = await store.create({ owner_id: "o", persona_id: "p", title: "parent" });
    const child = await store.create({
      owner_id: "o",
      persona_id: "p",
      parent_id: parent.session_id,
    });
    expect(child.parent_id).toBe(parent.session_id);
    expect(child.title).toBe("");
    store.close();
  });

  it("rejects invalid input with a typed error", async () => {
    const store = memoryStore();
    await expect(store.create({ owner_id: "", persona_id: "p" })).rejects.toMatchObject({
      name: "SessionStoreError",
      code: "validation_failed",
    });
    await expect(
      store.create({ owner_id: "o", persona_id: "p", title: 42 as unknown as string }),
    ).rejects.toMatchObject({ code: "validation_failed" });
    store.close();
  });
});

describe("append + read", () => {
  it("assigns seqs in one transaction and reads back ordered", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    const batch = [
      userMsg(meta.session_id, "t1", "hello"),
      assistantMsg(meta.session_id, "t1", "hi"),
    ];
    const stored = await store.append(meta.session_id, batch);
    expect(stored.map((e) => e.seq)).toEqual([2, 3]);
    expect(stored.map((e) => e.type)).toEqual(["message.user", "message.assistant"]);

    const all = await store.read(meta.session_id);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    // payload_json keeps the whole event minus seq — replay must see it all
    expect(all[1]).toEqual({ ...batch[0], seq: 2 });

    // from_seq is inclusive, limit applies
    expect((await store.read(meta.session_id, 2)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await store.read(meta.session_id, 2, 1)).map((e) => e.seq)).toEqual([2]);
    store.close();
  });

  it("updates sessions.updated_at on append", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    await new Promise((r) => setTimeout(r, 5));
    await store.append(meta.session_id, [userMsg(meta.session_id, "t1", "x")]);
    const after = await store.meta(meta.session_id);
    expect(after?.updated_at).toBeGreaterThan(meta.created_at);
    store.close();
  });

  it("throws typed errors for unknown session and session_id mismatch", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    await expect(store.append("nope", [userMsg("nope", "t", "x")])).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      store.append(meta.session_id, [userMsg("other-session", "t", "x")]),
    ).rejects.toMatchObject({ code: "validation_failed" });
    await expect(store.read("nope")).rejects.toMatchObject({ code: "not_found" });
    store.close();
  });

  it("accepts an empty batch as a no-op", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    const stored = await store.append(meta.session_id, []);
    expect(stored).toEqual([]);
    expect(await store.read(meta.session_id)).toHaveLength(1);
    store.close();
  });
});

describe("seq discipline", () => {
  it("keeps per-session order strictly increasing, batches consecutive, global seq gapless and unique", async () => {
    const store = memoryStore();
    const a = await store.create({ owner_id: "o", persona_id: "p", title: "A" });
    const b = await store.create({ owner_id: "o", persona_id: "p", title: "B" });

    const batches: Array<[string, number]> = [
      [a.session_id, 3],
      [b.session_id, 2],
      [a.session_id, 1],
      [b.session_id, 4],
      [a.session_id, 5],
      [b.session_id, 2],
    ];
    const returned: Array<{ sid: string; seqs: number[] }> = [];
    let n = 0;
    for (const [sid, count] of batches) {
      n += 1;
      const events: SessionEvent[] = [];
      for (let i = 0; i < count; i += 1) {
        events.push(userMsg(sid, `t${n}`, `m${i}`));
      }
      const stored = await store.append(sid, events);
      returned.push({ sid, seqs: stored.map((e) => e.seq) });
    }

    // within one append batch, assigned seqs are consecutive
    for (const { seqs } of returned) {
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]).toBe(seqs[i - 1]! + 1);
      }
    }
    // per-session reads come back strictly increasing in seq order
    for (const sid of [a.session_id, b.session_id]) {
      const seqs = (await store.read(sid)).map((e) => e.seq);
      for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
      // every session's log starts with its session.created event
      const first = (await store.read(sid))[0];
      expect(first?.type).toBe("session.created");
    }
    // the global sequence is gapless and never reused (1..N, all unique)
    const global = (
      store.db.prepare("SELECT seq FROM events ORDER BY seq").all() as { seq: number }[]
    ).map((r) => r.seq);
    expect(global).toEqual(global.map((_, i) => i + 1));
    expect(new Set(global).size).toBe(global.length);
    const total = batches.reduce((acc, [, c]) => acc + c, 0) + 2; // + 2 session.created
    expect(global.length).toBe(total);
    store.close();
  });
});

describe("meta + list", () => {
  it("meta returns null for unknown sessions", async () => {
    const store = memoryStore();
    expect(await store.meta("nope")).toBeNull();
    store.close();
  });

  it("lists by updated_at desc, filters by owner, caps at default 50", async () => {
    const store = memoryStore();
    const created = [];
    for (let i = 0; i < 55; i += 1) {
      created.push(
        await store.create({
          owner_id: i % 2 === 0 ? "alice" : "bob",
          persona_id: "p",
          title: `s${i}`,
        }),
      );
    }
    // touch the oldest so it becomes the most recently updated
    await new Promise((r) => setTimeout(r, 5)); // ensure a strictly newer updated_at
    await store.append(created[0]!.session_id, [userMsg(created[0]!.session_id, "t", "bump")]);

    const all = await store.list();
    expect(all).toHaveLength(50); // default limit
    expect(all[0]?.session_id).toBe(created[0]!.session_id); // most recently updated first
    expect(all[0]?.title).toBe("s0");

    const alice = await store.list({ owner_id: "alice" });
    expect(alice.every((m) => m.owner_id === "alice")).toBe(true);
    expect(alice.length).toBeLessThan(50);

    const page = await store.list({ limit: 5 });
    expect(page).toHaveLength(5);
    store.close();
  });
});

describe("pragmas + file vs memory", () => {
  it("file-backed databases run in WAL mode with foreign keys enforced", async () => {
    const store = await fileStore();
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(store.db.pragma("foreign_keys", { simple: true })).toBe(1);
    // the FK constraint is live at the SQL layer, not just in our code paths
    expect(() =>
      store.db
        .prepare("INSERT INTO events (session_id, type, payload_json, ts) VALUES (?, ?, ?, ?)")
        .run("bogus-session", "turn.started", "{}", 0),
    ).toThrow(/FOREIGN KEY/i);
    store.close();
  });

  it(":memory: databases work (journal stays memory)", async () => {
    const store = memoryStore();
    expect(store.db.pragma("journal_mode", { simple: true })).toBe("memory");
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    await store.append(meta.session_id, [userMsg(meta.session_id, "t", "x")]);
    expect(await store.read(meta.session_id)).toHaveLength(2);
    store.close();
  });
});

describe("shared handle", () => {
  it("reuses an injected db, runs migrations idempotently, and does not close it", async () => {
    const store = await fileStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p", title: "original" });

    // A second store on the same handle (the @nyx/policy sharing pattern).
    const sharing = new SessionStoreImpl("unused-when-db-given", { db: store.db });
    expect(await sharing.meta(meta.session_id)).toEqual(meta);
    await sharing.append(meta.session_id, [userMsg(meta.session_id, "t2", "from sharer")]);
    expect(await store.read(meta.session_id)).toHaveLength(2);

    sharing.close(); // must NOT close the provider's handle
    expect(store.db.open).toBe(true);
    await store.append(meta.session_id, [userMsg(meta.session_id, "t3", "still alive")]);
    expect(await store.read(meta.session_id)).toHaveLength(3);
    store.close();
    expect(store.db.open).toBe(false);
  });
});

describe("close", () => {
  it("rejects further use and is idempotent", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    store.close();
    store.close(); // idempotent
    await expect(
      store.append(meta.session_id, [userMsg(meta.session_id, "t", "x")]),
    ).rejects.toMatchObject({
      code: "closed",
    });
    await expect(store.read(meta.session_id)).rejects.toMatchObject({ code: "closed" });
    await expect(store.projection(meta.session_id)).rejects.toMatchObject({ code: "closed" });
  });
});

describe("debug validation", () => {
  it("validates events against the protocol schemas when enabled", async () => {
    const store = memoryStore({ validate: true });
    const meta = await store.create({ owner_id: "o", persona_id: "p", engagement });
    const ok = userMsg(meta.session_id, "t1", "fine");
    const stored = await store.append(meta.session_id, [ok]);
    expect(stored[0]?.seq).toBe(2);
    // read path also validates and passes
    expect(await store.read(meta.session_id)).toHaveLength(2);

    const malformed = {
      type: "message.user",
      session_id: meta.session_id,
      turn_id: "t1",
      content: "not-an-array",
      ts: 1,
    } as unknown as SessionEvent;
    await expect(store.append(meta.session_id, [malformed])).rejects.toMatchObject({
      code: "validation_failed",
      name: SessionStoreError.name,
    });
    store.close();
  });

  it("does not validate by default (hot path stays schema-free)", async () => {
    const store = memoryStore();
    const meta = await store.create({ owner_id: "o", persona_id: "p" });
    // shape-valid for the store's internal trust boundary, but carrying an
    // extra field a strict schema would still accept; the point is no zod runs
    const ev = userMsg(meta.session_id, "t1", "x");
    await expect(store.append(meta.session_id, [ev])).resolves.toBeTruthy();
    store.close();
  });
});
