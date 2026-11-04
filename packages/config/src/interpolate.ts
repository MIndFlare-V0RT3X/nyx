// SPDX-License-Identifier: AGPL-3.0-or-later
// ${VAR} interpolation over the raw YAML tree, before validation.
//
// Rules:
// - Applies to string *values* only, never to keys.
// - Whole-string `${VAR}` yields the exact env value; embedded
//   `prefix${VAR}suffix` is concatenated.
// - Only POSIX-ish names interpolate: [A-Za-z_][A-Za-z0-9_]*. Anything else
//   (e.g. `$HOME`, `${1bad}`) is left literally as written.
// - A referenced-but-unset var is a ConfigError naming the var, the config
//   file, and the field path where it occurred.
// - Resolved values are collected so the loader can keep them out of any
//   error message (they may be secrets; they must never be logged).

import { ConfigError, formatFieldPath } from "./errors.js";

const ENV_REF_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface InterpolationResult {
  /** The interpolated tree (fresh objects; the input tree is not mutated). */
  value: unknown;
  /** Non-empty values resolved from env, for redaction in error messages. */
  resolvedEnvValues: string[];
}

export function interpolateEnvVars(
  node: unknown,
  env: Record<string, string | undefined>,
  configPath: string,
): InterpolationResult {
  const resolvedEnvValues: string[] = [];
  const value = walk(node, [], env, configPath, resolvedEnvValues);
  return { value, resolvedEnvValues };
}

function walk(
  node: unknown,
  path: readonly (string | number)[],
  env: Record<string, string | undefined>,
  configPath: string,
  resolvedEnvValues: string[],
): unknown {
  if (typeof node === "string") {
    return interpolateString(node, path, env, configPath, resolvedEnvValues);
  }
  if (Array.isArray(node)) {
    return node.map((item, index) =>
      walk(item, [...path, index], env, configPath, resolvedEnvValues),
    );
  }
  if (node !== null && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(node)) {
      // Keys are deliberately not interpolated.
      out[key] = walk(val, [...path, key], env, configPath, resolvedEnvValues);
    }
    return out;
  }
  return node;
}

function interpolateString(
  text: string,
  path: readonly (string | number)[],
  env: Record<string, string | undefined>,
  configPath: string,
  resolvedEnvValues: string[],
): string {
  return text.replace(ENV_REF_PATTERN, (_match: string, name: string): string => {
    // hasOwnProperty, not `in`: process.env sits on Object.prototype's child
    // and `${toString}` must not "resolve" to an inherited function.
    const value = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
    if (value === undefined) {
      throw new ConfigError(
        `Missing environment variable ${name} referenced at ${formatFieldPath(path)} in ${configPath} (from template "${text}")`,
      );
    }
    if (value.length > 0) resolvedEnvValues.push(value);
    return value;
  });
}
