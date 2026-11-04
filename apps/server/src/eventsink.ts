// SPDX-License-Identifier: AGPL-3.0-or-later
// The EventSink: the server's single serialized appender into the session
// event log. Every event that reaches the store from THIS process — the agent
// loop's pump (via the wrapped store handed to the loop), the approval
// engine's post-commit callbacks, the turn runner's failure path — is chained
// through one promise queue, so appends can never interleave and the global
// seq order is a total order of committed batches.
//
// Store-first, single writer, ordered: the store remains the only source of
// truth; the sink only serializes who may write next.

import type { SessionEvent, SessionStore, StoredEvent } from "@nyx/protocol";

export interface EventSinkOptions {
  /**
   * Called inside the serialized chain, after the store has committed the
   * batch and assigned seqs. The tool-event audit path hangs off this: the
   * server routes stored tool.call / tool.result / tool.error /
   * action.denied events into the hash-chained audit log with their seq.
   * Throwing here fails the append call — audit failures are loud, never
   * silent.
   */
  onAppended?: (stored: StoredEvent[]) => void;
}

export interface EventSink {
  /** Append through the serialized chain; resolves with the stored events. */
  append(session_id: string, events: SessionEvent[]): Promise<StoredEvent[]>;
  /**
   * A SessionStore view over the sink's backing store: every method
   * delegates, except `append`, which routes through the sink. This is the
   * store the agent loop receives as `ctx.session`.
   */
  readonly wrapped: SessionStore;
}

export function createEventSink(store: SessionStore, opts: EventSinkOptions = {}): EventSink {
  let chain: Promise<unknown> = Promise.resolve();

  const append = (session_id: string, events: SessionEvent[]): Promise<StoredEvent[]> => {
    const run = chain.then(async () => {
      const stored = await store.append(session_id, events);
      opts.onAppended?.(stored);
      return stored;
    });
    // The chain survives a failed link: the next append still runs, and the
    // failure is reported only to the caller of that append.
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const wrapped: SessionStore = {
    create: (input) => store.create(input),
    append: (session_id, events) => append(session_id, events),
    read: (session_id, from_seq, limit) => store.read(session_id, from_seq, limit),
    stream: (session_id, from_seq) => store.stream(session_id, from_seq),
    fork: (session_id, at_seq) => store.fork(session_id, at_seq),
    meta: (session_id) => store.meta(session_id),
    list: (opts) => store.list(opts),
    projection: (session_id) => store.projection(session_id),
    rebuildProjections: () => store.rebuildProjections(),
    archiveSession: (session_id) => store.archiveSession(session_id),
    close: () => store.close(),
  };

  return { append, wrapped };
}
