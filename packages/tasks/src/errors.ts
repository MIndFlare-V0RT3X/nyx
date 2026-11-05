// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed errors for the durable-task system. Codes are stable strings the
// surfaces (HTTP API, CLI) map onto their own error bodies.

export type TaskErrorCode =
  "not_found" | "validation_failed" | "illegal_transition" | "lease_lost" | "not_supported";

export class TaskError extends Error {
  readonly code: TaskErrorCode;

  constructor(code: TaskErrorCode, message: string) {
    super(message);
    this.name = "TaskError";
    this.code = code;
  }
}
