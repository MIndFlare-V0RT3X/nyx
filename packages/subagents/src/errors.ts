// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed subagent errors. Codes are the contract the tests (and the report)
// assert on: depth_exceeded, budget_exceeded, validation_failed,
// no_parent_context, not_supported.

export type SubagentErrorCode =
  | "depth_exceeded"
  | "budget_exceeded"
  | "validation_failed"
  | "no_parent_context"
  | "not_supported"
  | "spawn_failed"
  | "aborted"
  /** Phase 4 §4: the child sandbox is gone (unknown or reaped). */
  | "not_found"
  /** Phase 4 §4: an artifact failed its audited-hash verification. */
  | "artifact_integrity";

export class SubagentError extends Error {
  readonly code: SubagentErrorCode;

  constructor(code: SubagentErrorCode, message: string) {
    super(message);
    this.name = "SubagentError";
    this.code = code;
  }
}
