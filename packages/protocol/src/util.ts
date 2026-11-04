// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared primitives used across every NYX package. Pure: no I/O.

/** Token accounting for a model call or a turn. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** Transport-safe error shape. Never contains secrets (see @nyx/model redaction). */
export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  retryable?: boolean;
}

/** Loose JSON Schema description used in tool definitions and model requests. */
export interface JsonSchema {
  type?: string;
  [key: string]: unknown;
}

/** Compaction strategies. Phase 0 implements `rule-elision` only; the rest are seams. */
export type CompactionStrategy =
  "rule-elision" | "llm-summary" | "session-memory" | "emergency-degrade";

/** Structured hint returned by the `feedback.recover` hook. */
export interface RecoveryHint {
  strategy: "retry" | "abort" | "downgrade_model" | "trim_context";
  note: string;
}

/** Minimal structured logger (pino-compatible subset). */
export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Named service lookup owned by the kernel. */
export interface ServiceRegistry {
  get<T>(name: string): T | undefined;
  set(name: string, service: unknown): void;
  has(name: string): boolean;
  delete(name: string): void;
}

/** The fixed section ids of the assembled system prompt, in assembly order. */
export type SectionId =
  | "BASE_PREAMBLE"
  | "CONTRACT"
  | "SOUL"
  | "USER"
  | "MEMORY_CATALOG"
  | "SKILLS_CATALOG"
  | "TOOLS_CATALOG"
  | "SESSION_CONTEXT";

/** One section of the assembled system prompt. Sections stay separate blocks. */
export interface PromptSection {
  id: SectionId;
  title: string;
  body: string;
}

/** Machine-readable error codes used across packages. */
export type NyxErrorCode =
  | "policy_denied"
  | "approval_denied"
  | "approval_expired"
  | "scope_denied"
  | "path_escape"
  | "tool_unknown"
  | "tool_timeout"
  | "tool_failed"
  | "validation_failed"
  | "capability"
  | "engagement_required"
  | "budget_exceeded"
  | "provider_error"
  | "aborted"
  | "not_implemented";

/**
 * Canonical JSON: object keys sorted lexicographically at every depth,
 * arrays preserved in order, `undefined` values dropped. Used for action
 * digests and audit-chain hashing — identical logical input must always
 * produce a byte-identical string.
 */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

function serializeCanonical(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "number") return Number.isFinite(value) ? String(value) : "null";
  if (t === "boolean") return value ? "true" : "false";
  if (t === "bigint") return String(value);
  if (Array.isArray(value))
    return `[${value.map((v) => serializeCanonical(v === undefined ? null : v)).join(",")}]`;
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeCanonical(obj[k])}`).join(",")}}`;
  }
  // functions / symbols have no canonical form
  return "null";
}

/** Coerce any thrown value into a SerializedError without leaking internals. */
export function toSerializedError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const coded = err as Error & { code?: string; retryable?: boolean };
    return {
      name: err.name,
      message: err.message,
      ...(coded.code !== undefined ? { code: coded.code } : {}),
      ...(err.stack ? { stack: err.stack } : {}),
      ...(coded.retryable !== undefined ? { retryable: coded.retryable } : {}),
    };
  }
  if (typeof err === "object" && err !== null) {
    const e = err as { name?: unknown; message?: unknown };
    if (typeof e.name === "string" && typeof e.message === "string") {
      return { name: e.name, message: e.message };
    }
  }
  return { name: "UnknownError", message: String(err) };
}

/** Merge partial Usage objects (missing fields default to 0). */
export function mergeUsage(...parts: Array<Usage | undefined>): Usage {
  const out: Usage = { input_tokens: 0, output_tokens: 0 };
  let reasoning = 0;
  let cache = 0;
  for (const p of parts) {
    if (!p) continue;
    out.input_tokens += p.input_tokens ?? 0;
    out.output_tokens += p.output_tokens ?? 0;
    reasoning += p.reasoning_tokens ?? 0;
    cache += p.cache_read_tokens ?? 0;
  }
  if (reasoning) out.reasoning_tokens = reasoning;
  if (cache) out.cache_read_tokens = cache;
  out.total_tokens = out.input_tokens + out.output_tokens + reasoning;
  return out;
}
