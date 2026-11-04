// SPDX-License-Identifier: AGPL-3.0-or-later
// @nyx/protocol — the frozen shared contract. Everything else composes around it.
//
// Pure types plus boundary Zod schemas and two tiny pure helpers
// (canonicalJson, toSerializedError). No I/O, no clock, no filesystem.

export * from "./util.js";
export * from "./schemas.js";
export { CapabilityError } from "./kernel.js";
export { SECTION_ORDER } from "./persona.js";
export { TASK_TRANSITIONS, CLAIMABLE_TASK_STATES, isLegalTaskTransition } from "./tasks.js";
export type * from "./content.js";
export type * from "./tools.js";
export type * from "./scope.js";
export type * from "./events.js";
export type * from "./model.js";
export type * from "./policy.js";
export type * from "./sandbox.js";
export type * from "./memory.js";
export type * from "./hooks.js";
export type * from "./kernel.js";
export type * from "./persona.js";
export type * from "./session.js";
export type * from "./agent.js";
export type * from "./subagents.js";
export type * from "./tasks.js";
