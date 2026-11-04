// SPDX-License-Identifier: AGPL-3.0-or-later
// Memory store contracts. Phase 0 retrieval is lexical (FTS5/BM25); the
// embedding path is a seam with a no-op default.
//
// Phase 3 adds the "subagent" scope: entries a subagent session wrote, namespaced
// by their source.session_id (the child session id). A subagent's memory view
// (@nyx/subagents SubagentMemory) is the only reader/writer of that scope — it
// maps the child's "session"-scope traffic onto "subagent" so a child can
// never read or write its parent's session memory, structurally.

export type MemoryScope = "session" | "persona" | "owner" | "global" | "subagent";

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  kind: "fact" | "preference" | "procedure" | "episode" | "skill-note";
  content: string;
  source: { session_id?: string; turn_id?: string; path?: string };
  tags: string[];
  created_at: number;
  updated_at: number;
}

export interface MemorySearchOptions {
  scope?: MemoryScope[];
  limit?: number;
  min_score?: number;
}

export interface MemoryStore {
  write(entry: Omit<MemoryEntry, "id" | "created_at" | "updated_at">): Promise<MemoryEntry>;
  search(
    query: string,
    opts?: MemorySearchOptions,
  ): Promise<Array<MemoryEntry & { score: number }>>;
  get(id: string): Promise<MemoryEntry | null>;
  list(opts?: {
    scope?: MemoryScope[];
    kind?: MemoryEntry["kind"];
    limit?: number;
  }): Promise<MemoryEntry[]>;
  compact(): Promise<{ merged: number; dropped: number }>;
}

/** Seam for vector retrieval; no-op default in Phase 0. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}
