// SPDX-License-Identifier: AGPL-3.0-or-later
// ConfigError and error-message formatting. Every failure mode of loadConfig()
// (unreadable file, YAML syntax error, missing env var, Zod validation)
// surfaces as a ConfigError whose message names the config file path and, when
// known, the YAML line and/or the field path of the offending value.

import type { z } from "zod";

/** The only error code this package emits; matches NyxErrorCode in @nyx/protocol. */
export type ConfigErrorCode = "validation_failed";

/** Typed error thrown by every loadConfig() failure path. */
export class ConfigError extends Error {
  readonly code: ConfigErrorCode = "validation_failed";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "ConfigError";
  }
}

/** Render a Zod issue path as a dotted field path with `[index]` for arrays. */
export function formatFieldPath(segments: readonly (string | number)[]): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (out === "") {
      out = segment;
    } else {
      out += `.${segment}`;
    }
  }
  return out === "" ? "(root)" : out;
}

/**
 * Replace any occurrence of env-resolved values with a placeholder. Zod
 * messages sometimes echo the received value (enum mismatches); if that value
 * came from an env var it must never appear in a message that will be logged.
 */
export function redactEnvValues(text: string, envValues: readonly string[]): string {
  // Longest first so an alternation prefers the longest match at a position.
  // One single pass: chained replacements could otherwise re-redact the
  // placeholder itself (it contains common letters).
  const values = [...new Set(envValues.filter((v) => v.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (values.length === 0) return text;
  const pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
  return text.replace(pattern, () => "<redacted env value>");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Format a ZodError into a human-readable block naming the config file and a
 * dotted field path per issue. Unknown keys (typos) get their own line so the
 * field path points at the typo itself.
 */
export function formatConfigValidationMessage(
  error: z.ZodError,
  configPath: string,
  envValues: readonly string[],
): string {
  const lines: string[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys" && issue.keys.length > 0) {
      const isTopLevel = issue.path.length === 0;
      for (const key of issue.keys) {
        const hint = isTopLevel
          ? " (not a known top-level section — typo? see nyx.config.example.yaml)"
          : "";
        lines.push(`  at ${formatFieldPath([...issue.path, key])}: unrecognized key "${key}"${hint}`);
      }
    } else {
      lines.push(`  at ${formatFieldPath(issue.path)}: ${redactEnvValues(issue.message, envValues)}`);
    }
  }
  return `Config validation failed for ${configPath}:\n${lines.join("\n")}`;
}
