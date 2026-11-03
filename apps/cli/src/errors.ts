// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed CLI errors. Every failure a command must distinguish (bad input,
// missing entity, wiring failure) throws a CliError with a `code`, so the
// Commander entry can print a precise message and set the right exit code.

export type CliErrorCode =
  | "validation_failed"
  | "not_found"
  | "approval_denied"
  | "approval_expired"
  | "config_error"
  | "runtime_error";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CliError";
    this.code = code;
  }
}

/** Coerce any thrown value into a one-line human message for stderr output. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
