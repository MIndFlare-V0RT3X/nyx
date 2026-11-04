// SPDX-License-Identifier: AGPL-3.0-or-later
// The subagent's memory view — the structural isolation boundary (Phase 3
// §2.5, hard rule #2). The child's RunContext.memory is this view, never the
// parent's store:
//
//   writes: a "session"-scope write (what the compaction pipeline's Tier 2
//   emits) is MAPPED onto the "subagent" scope with source.session_id = the
//   child's session id. Every other scope is rejected — a subagent cannot
//   write persona/owner/global memory.
//
//   reads: only the child's own "subagent" entries plus the "global" scope.
//   A requested "session" scope is translated to the child's subagent
//   entries (so Tier 3's session-memory precondition keeps working inside
//   the child). The parent's "session" scope is never reachable — not by
//   instruction, by API surface.
//
// compact() is a no-op: a subagent never triggers store-wide compaction.

import type {
  MemoryEntry,
  MemoryScope,
  MemorySearchOptions,
  MemoryStore,
} from "@nyx/protocol";

/** Scopes a subagent may read: its own (translated) session scope + global. */
const READABLE: readonly MemoryScope[] = ["session", "subagent", "global"];

export class SubagentMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentMemoryError";
  }
}

export class SubagentMemory implements MemoryStore {
  constructor(
    private readonly inner: MemoryStore,
    private readonly childSessionId: string,
  ) {}

  async write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry> {
    if (entry.scope === "session") {
      // The one legal write, mapped onto the isolated subagent scope.
      return this.inner.write({
        ...entry,
        scope: "subagent",
        source: { ...entry.source, session_id: this.childSessionId },
      });
    }
    throw new SubagentMemoryError(
      `subagents may only write their own session scope (requested "${entry.scope}"); ` +
        'scope "session" is mapped to the isolated "subagent" scope automatically',
    );
  }

  async search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<Array<MemoryEntry & { score: number }>> {
    const rows = await this.inner.search(query, {
      ...opts,
      scope: this.translateScopes(opts?.scope),
    });
    return rows.filter((e) => this.owns(e));
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = await this.inner.get(id);
    return entry !== null && this.owns(entry) ? entry : null;
  }

  async list(opts?: {
    scope?: MemoryScope[];
    kind?: MemoryEntry["kind"];
    limit?: number;
  }): Promise<MemoryEntry[]> {
    const rows = await this.inner.list({
      ...opts,
      scope: this.translateScopes(opts?.scope),
      limit: opts?.limit === undefined ? undefined : opts.limit,
    });
    const owned = rows.filter((e) => this.owns(e));
    return opts?.limit === undefined ? owned : owned.slice(0, opts.limit);
  }

  async compact(): Promise<{ merged: number; dropped: number }> {
    return { merged: 0, dropped: 0 };
  }

  // ---- internals ---------------------------------------------------------

  /** "session" → the child's subagent entries; "global" passes; the rest drop out. */
  private translateScopes(scopes?: MemoryScope[]): MemoryScope[] {
    if (scopes === undefined) return ["subagent", "global"];
    const out = new Set<MemoryScope>();
    for (const scope of scopes) {
      if (scope === "session" || scope === "subagent") out.add("subagent");
      else if (scope === "global") out.add("global");
      // persona / owner: not readable by a subagent — silently excluded
      // (deny-first; requesting them is not an error, they just aren't there).
    }
    return [...out];
  }

  /** True for global entries and for THIS child's subagent entries — nothing else. */
  private owns(entry: MemoryEntry): boolean {
    if (entry.scope === "global") return true;
    return entry.scope === "subagent" && entry.source.session_id === this.childSessionId;
  }
}

/** Exposed for tests/docs: the scopes a subagent can read. */
export const SUBAGENT_READABLE_SCOPES = READABLE;
