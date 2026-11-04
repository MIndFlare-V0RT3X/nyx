// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/db — the unified database. One nyx.db, one connection, one transaction
// per event+audit append; split-DB layouts migrate on open.

export { openUnifiedDatabase, LEGACY_DB_FILES } from "./unify.js";
export type { UnifiedDb, UnifiedDbOptions } from "./unify.js";
