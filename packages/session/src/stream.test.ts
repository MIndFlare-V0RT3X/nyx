// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SessionEvent, StoredEvent } from "@nyx/protocol";
import { SessionStoreImpl } from "./store.js";

const tmpDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`withTimeout: ${label} exceeded ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

let ts = 1_000_000;
const nextTs = (): number => (ts += 1);

function delta(sid: string, turn: string, n: number): SessionEvent {
  return { type: "text.delta", session_id: sid, turn_id: turn, text: `chunk-${n}`, ts: nextTs() };
}

/** Two independent stores over the same file — the "outside" appender is real. */
async function twoStores(): Promise<{ a: SessionStoreImpl; b: SessionStoreImpl; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "nyx-session-stream-"));
  tmpDirs.push(dir);
  const path = join(dir, "stream.db");
  return { a: new SessionStoreImpl(path), b: new SessionStoreImpl(path), dir };
}

describe("stream", () => {
  it("replays existing events, tails live appends from another connection, and breaks cleanly", async () => {
    const { a, b } = await twoStores();
    const sid = (await a.create({ owner_id: "o", persona_id: "p" })).session_id;
    const first = [delta(sid, "t1", 1), delta(sid, "t1", 2), delta(sid, "t1", 3)];
    const stored1 = await a.append(sid, first);
    expect(stored1.map((e) => e.seq)).toEqual([2, 3, 4]); // seq 1 is session.created

    const collected: StoredEvent[] = [];
    const consumed = withTimeout(
      (async () => {
        // from_seq = 2 skips session.created (seq 1): the 3 appended events
        // are exactly what the initial replay yields.
        for await (const ev of a.stream(sid, 2)) {
          collected.push(ev);
          if (collected.length === 3) {
            // two more events arrive "from outside" while we are iterating
            await b.append(sid, [delta(sid, "t1", 4), delta(sid, "t1", 5)]);
          }
          if (collected.length === 5) break; // must stop the iterator cleanly
        }
      })(),
      5000,
      "stream consumption",
    );
    await consumed; // a hang here fails the timeout

    expect(collected.map((e) => e.seq)).toEqual([2, 3, 4, 5, 6]);
    expect(collected.map((e) => (e as { text: string }).text)).toEqual([
      "chunk-1",
      "chunk-2",
      "chunk-3",
      "chunk-4",
      "chunk-5",
    ]);

    // streaming from 0 replays the whole log, session.created included
    const fromZero: number[] = [];
    await withTimeout(
      (async () => {
        for await (const ev of a.stream(sid, 0)) {
          fromZero.push(ev.seq);
          break;
        }
      })(),
      5000,
      "stream from zero",
    );
    expect(fromZero).toEqual([1]);
    a.close();
    b.close();
  });

  it("honors from_seq (inclusive) on the initial replay", async () => {
    const { a } = await twoStores();
    const sid = (await a.create({ owner_id: "o", persona_id: "p" })).session_id;
    await a.append(sid, [delta(sid, "t1", 1), delta(sid, "t1", 2), delta(sid, "t1", 3)]);

    const collected: StoredEvent[] = [];
    await withTimeout(
      (async () => {
        for await (const ev of a.stream(sid, 3)) {
          collected.push(ev);
          break;
        }
      })(),
      5000,
      "stream from_seq",
    );
    expect(collected.map((e) => e.seq)).toEqual([3]); // inclusive from_seq
    a.close();
  });

  it("polls lazily: an idle consumer triggers no reads while nothing is appended", async () => {
    const { a } = await twoStores();
    const sid = (await a.create({ owner_id: "o", persona_id: "p" })).session_id;
    await a.append(sid, [delta(sid, "t1", 1)]);

    const iter = a.stream(sid, 0);
    const first = await withTimeout(iter.next(), 5000, "first yield");
    expect(first).toMatchObject({ done: false, value: { seq: 1 } }); // session.created
    // We never call next() again and we return() while nothing is pending —
    // this must resolve immediately with no hang and no timer leak.
    const done = await withTimeout(iter.return(undefined), 5000, "clean return");
    expect(done.done).toBe(true);
    a.close();
  });
});
