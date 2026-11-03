// SPDX-License-Identifier: AGPL-3.0-or-later
// Typed provider errors and transport-agnostic classification. Both the
// OpenAI-compatible and the Anthropic provider surface failures as
// ProviderError; the classification works on error *shape* (http status /
// error name), so it applies to either SDK without importing one into the
// other's module graph.

import type { SerializedError } from "@nyx/protocol";
import { toSafeSerializedError } from "./redact.js";

/** Retryable failure codes the router knows how to fall back on. */
export type RetryableCode = "rate_limit" | "server_error" | "timeout";

/**
 * Error thrown by every provider in this package. Carries a stable machine
 * `code` and a `retryable` flag so the router can decide fallback behavior
 * without string-matching messages.
 */
export class ProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    opts: { code: string; retryable?: boolean; name?: string; cause?: unknown },
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = opts.name ?? "ProviderError";
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
  }
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err === "object" && err !== null) {
    const status = (err as { status?: unknown }).status;
    if (typeof status === "number") return status;
  }
  return undefined;
}

function errorName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; constructor?: { name?: unknown } };
    // SDK error classes do not set .name (it stays "Error"); the class name
    // is the reliable discriminator.
    if (typeof e.name === "string" && e.name !== "Error") return e.name;
    const ctorName = e.constructor?.name;
    if (typeof ctorName === "string") return ctorName;
  }
  return "";
}

function causeName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const cause = (err as { cause?: unknown }).cause;
    if (typeof cause === "object" && cause !== null) {
      const name = (cause as { name?: unknown }).name;
      if (typeof name === "string") return name;
    }
  }
  return "";
}

function retryableByDefault(code: string): boolean {
  return code === "rate_limit" || code === "server_error" || code === "timeout";
}

/**
 * Classify a thrown value from a provider SDK into a redacted SerializedError
 * with a stable code and retryability:
 *
 * - abort (user AbortController) → "aborted", not retryable
 * - timeout (SDK timeout or AbortSignal.timeout) → "timeout", retryable
 * - HTTP 429 → "rate_limit", retryable
 * - HTTP 401/403 → "auth", not retryable
 * - HTTP 5xx → "server_error", retryable
 * - connection-level failure → "server_error", retryable
 * - anything already carrying a code (e.g. a ProviderError) keeps it
 * - otherwise → "provider_error", not retryable
 */
export function classifyProviderError(err: unknown): SerializedError {
  const base = toSafeSerializedError(err);
  const name = errorName(err);
  const status = httpStatus(err);

  // Timeout before abort: AbortSignal.timeout() surfaces as an abort error
  // whose cause is a TimeoutError DOMException.
  let code: string;
  let retryable: boolean;
  if (name === "APIConnectionTimeoutError" || causeName(err) === "TimeoutError") {
    code = "timeout";
    retryable = true;
  } else if (name === "AbortError" || name === "APIUserAbortError") {
    code = "aborted";
    retryable = false;
  } else if (status === 429) {
    code = "rate_limit";
    retryable = true;
  } else if (status === 401 || status === 403) {
    code = "auth";
    retryable = false;
  } else if (status !== undefined && status >= 500 && status <= 599) {
    code = "server_error";
    retryable = true;
  } else if (name === "APIConnectionError") {
    // Unreachable host / refused connection: treat as a server-side outage.
    code = "server_error";
    retryable = true;
  } else if (base.code !== undefined) {
    code = base.code;
    retryable = base.retryable ?? retryableByDefault(code);
  } else {
    code = "provider_error";
    retryable = false;
  }
  return { ...base, code, retryable };
}

/**
 * Convert any thrown value into a ProviderError, preserving the redacted
 * serialized fields (name/message/code/retryable) and keeping the original
 * as `cause`.
 */
export function toProviderError(err: unknown): ProviderError {
  const ser = classifyProviderError(err);
  return new ProviderError(ser.message, {
    code: ser.code ?? "provider_error",
    retryable: ser.retryable ?? false,
    name: ser.name,
    cause: err,
  });
}
