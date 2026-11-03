// SPDX-License-Identifier: AGPL-3.0-or-later
// Embedder seam. Phase 0 retrieval is lexical (FTS5/BM25); the vector path
// exists only as this interface so later phases can swap it in without
// touching the store's public surface.

import type { Embedder } from "@nyx/protocol";

/**
 * Default embedder: returns an empty vector for every input. Wiring an
 * Embedder into MemoryStoreImpl changes nothing in Phase 0 — search stays
 * lexical until the retrieval layer consumes embeddings.
 */
export class NoopEmbedder implements Embedder {
  async embed(_text: string): Promise<number[]> {
    return [];
  }
}
