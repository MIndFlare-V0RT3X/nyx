// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/session — public surface.

export { openSessionStore, SessionStoreImpl, SessionStoreError } from "./store.js";
export type { SessionStoreOptions, SessionStoreErrorCode } from "./store.js";
export { APPROVAL_TTL_MS } from "./projections.js";
