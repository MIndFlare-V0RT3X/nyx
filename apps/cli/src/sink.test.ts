// SPDX-License-Identifier: AGPL-3.0-or-later
// EventSink behavior: serialized appends (one total order even when callers
// interleave), the wrapped store view, and chain survival after a failure.

import { describe, expect, it } from "vitest";
import { openSessionStore } from "@nyx/session";
import type { SessionEvent, SessionStore, StoredEvent } from "@nyx/protocol";
import { createEventSink } from "./sink.js";

function delta(session_id: string, turn_id: string, text: string): SessionEvent {
  return { type: "text.delta", session_id, turn_id, text, ts: Date.now() };
}

function withStore(fn: (store: SessionStore) => Promise<void>): Promise<void> {
  const store = openSessionStore(":memory:");
  return fn(store).finally(() => store.close());
}

describe("createEventSink", () => {
  it("wraps append: every append routes through the sink and lands in the store", async () => {
    await withStore(async (store) => {
      const session = await store.create({ owner_id: "owner", persona_id: "default" });
      const sink = createEventSink(store);
      const stored = await sink.append(session.session_id, [delta(session.session_id, "t1", "a")]);
      expect(stored).toHaveLength(1);
      expect(stored[0]?.seq).toBeGreaterThan(0);
      // session.created (from create) occupies seq 1; the delta is seq 2
      const read = await store.read(session.session_id, 2);
      expect(read).toHaveLength(1);
      expect(read[0]?.type).toBe("text.delta");
    });
  });

  it("serializes concurrent appends into one total order (no interleaved seqs)", async () => {
    await withStore(async (store) => {
      const session = await store.create({ owner_id: "owner", persona_id: "default" });
      const sink = createEventSink(store);
      // Fire loop-pump-style and callback-style appends concurrently; the
      // sink must chain them so the stored seqs are strictly increasing.
      const batches: Array<Promise<StoredEvent[]>> = [];
      for (let i = 0; i < 20; i++) {
        batches.push(sink.append(session.session_id, [delta(session.session_id, "t1", `b${i}`)]));
      }
      const all = await Promise.all(batches);
      const seqs = all.flat().map((e) => e.seq);
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(seqs).toEqual(sorted);
      const events = await store.read(session.session_id);
      expect(events).toHaveLength(21); // session.created + 20 deltas
      for (let i = 1; i < events.length; i++) {
        expect((events[i] as StoredEvent).seq).toBeGreaterThan((events[i - 1] as StoredEvent).seq);
      }
    });
  });

  it("the chain survives a failed link: the next append still runs", async () => {
    await withStore(async (store) => {
      const session = await store.create({ owner_id: "owner", persona_id: "default" });
      const sink = createEventSink(store);
      await expect(
        sink.append("no-such-session", [delta("no-such-session", "t1", "x")]),
      ).rejects.toThrow();
      const stored = await sink.append(session.session_id, [delta(session.session_id, "t1", "ok")]);
      expect(stored).toHaveLength(1);
    });
  });

  it("wrapped delegates every method but routes append through the sink", async () => {
    await withStore(async (store) => {
      const session = await store.create({ owner_id: "owner", persona_id: "default" });
      const sink = createEventSink(store);
      const wrapped = sink.wrapped;
      await wrapped.append(session.session_id, [delta(session.session_id, "t1", "w")]);
      expect(await wrapped.meta(session.session_id)).not.toBeNull();
      expect(await wrapped.list()).toHaveLength(1);
      expect((await wrapped.projection(session.session_id)).messages).toHaveLength(0);
      expect(await wrapped.read(session.session_id, 2)).toHaveLength(1);
    });
  });
});
