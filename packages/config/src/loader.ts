// SPDX-License-Identifier: AGPL-3.0-or-later
// loadConfig(): read nyx.config.yaml, interpolate ${VAR} refs, validate with
// the Zod schema, deep-freeze the result. The loader itself never logs —
// in particular it never logs env-resolved values (they may be secrets); env
// values are even kept out of validation error messages.

import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import { DEFAULT_CONFIG_PATH } from "./brand.js";
import { interpolateEnvVars } from "./interpolate.js";
import { ConfigError, formatConfigValidationMessage } from "./errors.js";
import { configSchema, type NyxConfig } from "./schema.js";

export interface LoadConfigOptions {
  /**
   * Env var source for `${VAR}` interpolation. When provided it *replaces*
   * process.env entirely (hermetic for tests); when omitted, process.env is
   * used.
   */
  env?: Record<string, string | undefined>;
  /**
   * Phase 6.1 — the `--allow-direct-egress` CLI flag. The ONLY way
   * `sandbox.egress_proxy.enabled: false` passes validation, and even then
   * only with NYX_ENV=development (see validateEgressPolicy).
   */
  allowDirectEgress?: boolean;
}

/**
 * Load, interpolate, validate, and freeze a NYX config.
 *
 * @param configPath Path to the config file; defaults to "./nyx.config.yaml".
 * @param opts Optional env override for interpolation (see LoadConfigOptions).
 * @throws {ConfigError} on unreadable file, YAML syntax error, missing env
 *   var, or schema violation. The message always names the config file path
 *   and, where known, the YAML line and/or the dotted field path.
 */
export async function loadConfig(
  configPath?: string,
  opts?: LoadConfigOptions,
): Promise<NyxConfig> {
  const path = configPath ?? DEFAULT_CONFIG_PATH;

  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Failed to read config file ${path}: ${errorMessage(err)}`, {
      cause: err,
    });
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConfigError(yamlSyntaxMessage(err, path), { cause: err });
  }

  // An empty (or all-comment) document is an empty mapping; a top-level key
  // explicitly set to null (`section:` with nothing under it) counts as
  // omitted so section defaults apply. Deeper nulls are left for the schema
  // to report.
  const normalized = normalizeDocument(raw);

  const env = opts?.env ?? process.env;
  const { value: interpolated, resolvedEnvValues } = interpolateEnvVars(normalized, env, path);

  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    throw new ConfigError(formatConfigValidationMessage(result.error, path, resolvedEnvValues), {
      cause: result.error,
    });
  }

  // Phase 6.1 hard rule 1: the egress proxy is required in production.
  // Disabling it is a dev-only escape hatch and must be explicit twice —
  // NYX_ENV=development AND the CLI flag.
  validateEgressPolicy(result.data, {
    nyxEnv: env.NYX_ENV,
    allowDirectEgress: opts?.allowDirectEgress === true,
    configPath: path,
  });

  return deepFreeze(result.data);
}

/**
 * The egress-proxy posture check (docs/EGRESS-PROXY.md "Escape hatch").
 * Exported for the apps to re-run against an already-loaded config when the
 * flag arrives after the load (it does not today, but the rule stays
 * load-bearing and testable in isolation).
 */
export function validateEgressPolicy(
  config: { sandbox: { egress_proxy: { enabled: boolean } } },
  opts: { nyxEnv: string | undefined; allowDirectEgress: boolean; configPath: string },
): void {
  if (config.sandbox.egress_proxy.enabled) return;
  if (opts.nyxEnv === "development" && opts.allowDirectEgress) return;
  const where =
    opts.nyxEnv === "development"
      ? "pass --allow-direct-egress to accept the documented Phase 5 posture"
      : `NYX_ENV is "${opts.nyxEnv ?? "unset"}", not "development"`;
  throw new ConfigError(
    `${opts.configPath}: sandbox.egress_proxy.enabled: false is not permitted — the ` +
      `egress proxy is required in production (${where}; see docs/EGRESS-PROXY.md)`,
  );
}

function normalizeDocument(raw: unknown): unknown {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return raw; // schema reports it
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== null) out[key] = value;
  }
  return out;
}

function yamlSyntaxMessage(err: unknown, path: string): string {
  if (err instanceof YAMLParseError) {
    const pos = err.linePos?.[0];
    const where = pos ? ` at line ${pos.line}, column ${pos.col}` : "";
    return `YAML syntax error in ${path}${where}: ${firstLine(err.message)}`;
  }
  return `Failed to parse YAML in ${path}: ${errorMessage(err)}`;
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : text.slice(0, idx);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Recursively freeze an object tree. The returned config is immutable at
 * runtime; the TypeScript type stays plain (not Readonly-mapped) so arrays
 * and objects remain assignable to protocol-typed parameters. Callers must
 * treat it as frozen anyway.
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (!Object.isFrozen(value)) Object.freeze(value);
    if (Array.isArray(value)) {
      for (const item of value) deepFreeze(item);
    } else {
      for (const key of Object.keys(value)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
    }
  }
  return value;
}
