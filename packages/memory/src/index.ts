// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/memory — markdown-backed memory store with an SQLite FTS5 index.
// Files are the source of truth; the index is a rebuildable mirror.

export { MemoryStoreImpl } from "./store.js";
export type { MemoryStoreOptions } from "./store.js";
export { sanitizeFtsQuery } from "./store.js";
export { NoopEmbedder } from "./embedder.js";
export { MemoryValidationError } from "./frontmatter.js";
export type {
  Embedder,
  MemoryEntry,
  MemoryScope,
  MemorySearchOptions,
  MemoryStore,
} from "@nyx/protocol";
