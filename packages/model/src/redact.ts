// SPDX-License-Identifier: AGPL-3.0-or-later
// Secret redaction used at every trust boundary in @nyx/model: provider error
// serialization, log payloads, and any object about to cross the wire. Fail
// closed — when in doubt, redact.

import type { SerializedError } from "@nyx/protocol";
import { toSerializedError } from "@nyx/protocol";

/** Value substituted for every redacted secret. */
export const REDACTED = "[redacted]";

/** Keys whose values are secrets, wherever they appear in an object tree. */
const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|credential/i;

/** OpenAI-style key material embedded in free text (message/stack). */
const SK_TOKEN = /sk-[A-Za-z0-9_-]{8,}/g;

/** JSON key/value pairs embedded in free text, e.g. {"api_key": "..."}. */
const JSON_SECRET_PAIR =
  /("(?:api[-_]?key|authorization|token|secret|credential)[^"]*")\s*:\s*"(?:[^"\\]|\\.)*"/gi;

/**
 * Deep-clone `value`, replacing the value of every key matching
 * /api[-_]?key|authorization|token|secret|credential/i (case-insensitive)
 * with "[redacted]". Plain objects, arrays, Maps, Sets and Dates are cloned;
 * class instances and functions are passed through by reference (they cannot
 * be cloned safely — do not feed untrusted class instances here).
 *
 * The key regex is deliberately over-broad (it matches e.g. "tokens_used"):
 * over-redaction is the safe failure mode, under-redaction is not.
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (value instanceof Date) return new Date(value.getTime());
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [key, val] of value) {
      out.set(
        redactSecrets(key),
        typeof key === "string" && SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(val),
      );
    }
    return out;
  }
  if (value instanceof Set) {
    return new Set([...value].map((item) => redactSecrets(item)));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactSecrets(val);
  }
  return out;
}

/** Scrub secret-looking tokens out of a free-text string. */
export function scrubSecretText(text: string): string {
  return text.replace(SK_TOKEN, "sk-[redacted]").replace(JSON_SECRET_PAIR, '$1: "[redacted]"');
}

function isSerializedErrorLike(value: unknown): value is SerializedError {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { name?: unknown; message?: unknown };
  return typeof v.name === "string" && typeof v.message === "string";
}

/**
 * Serialize any thrown value into a transport-safe SerializedError with all
 * secret material scrubbed:
 *
 * 1. protocol `toSerializedError` gives the base shape (name/message/code/
 *    stack/retryable for Error instances);
 * 2. code/retryable are re-attached when the input was a plain serialized
 *    error object (the protocol helper only preserves them on Errors);
 * 3. the whole shape is JSON round-tripped through `redactSecrets` so any
 *    embedded structured key/value pairs are dropped;
 * 4. message and stack are string-level scrubbed (sk- tokens and inline
 *    "key": "value" pairs).
 */
export function toSafeSerializedError(err: unknown): SerializedError {
  const base = toSerializedError(err);
  let code = base.code;
  let retryable = base.retryable;
  if ((code === undefined || retryable === undefined) && typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; retryable?: unknown };
    if (code === undefined && typeof e.code === "string") code = e.code;
    if (retryable === undefined && typeof e.retryable === "boolean") retryable = e.retryable;
  }
  const candidate: SerializedError = {
    name: base.name,
    message: base.message,
    ...(typeof code === "string" ? { code } : {}),
    ...(base.stack !== undefined ? { stack: base.stack } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  };
  let redacted: unknown;
  try {
    redacted = redactSecrets(JSON.parse(JSON.stringify(candidate)));
  } catch {
    // Circular / non-JSON payload: fall back to the unstructured fields.
    redacted = candidate;
  }
  const safe = isSerializedErrorLike(redacted)
    ? redacted
    : { name: "UnknownError", message: String(redacted) };
  return {
    name: safe.name,
    message: scrubSecretText(safe.message),
    ...(safe.code !== undefined ? { code: safe.code } : {}),
    ...(safe.stack !== undefined ? { stack: scrubSecretText(safe.stack) } : {}),
    ...(safe.retryable !== undefined ? { retryable: safe.retryable } : {}),
  };
}
