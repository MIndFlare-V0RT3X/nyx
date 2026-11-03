// SPDX-License-Identifier: AGPL-3.0-or-later
// Memory store contracts. Phase 0 retrieval is lexical (FTS5/BM25); the
// embedding path is a seam with a no-op default.

export type MemoryScope = "session" | "persona" | "owner" | "global";

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
  search(query: string, opts?: MemorySearchOptions): Promise<Array<MemoryEntry & { score: number }>>;
  get(id: string): Promise<MemoryEntry | null>;
  list(opts?: { scope?: MemoryScope[]; kind?: MemoryEntry["kind"]; limit?: number }): Promise<MemoryEntry[]>;
  compact(): Promise<{ merged: number; dropped: number }>;
}

/** Seam for vector retrieval; no-op default in Phase 0. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}
