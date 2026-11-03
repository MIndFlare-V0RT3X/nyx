// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed loop errors for outcomes a caller must distinguish BEFORE any turn
// event exists. Once a turn has started, the loop reports failures as
// turn.failed events instead of throwing.

export type AgentErrorCode = "not_implemented" | "not_found" | "provider_error";

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}
