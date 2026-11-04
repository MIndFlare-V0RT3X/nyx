// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/session — public surface.

export { openSessionStore, SessionStoreImpl, SessionStoreError } from "./store.js";
export type { SessionStoreOptions, SessionStoreErrorCode } from "./store.js";
export { APPROVAL_TTL_MS } from "./projections.js";
// 2.0.1: the drizzle migration runner is part of the unified-DB contract
// (@nyx/db ensures the session-store tables exist on a shared handle).
export { migrate } from "./migrate.js";
