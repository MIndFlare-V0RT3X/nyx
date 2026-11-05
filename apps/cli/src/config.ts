// SPDX-License-Identifier: AGPL-3.0-or-later
// Config + data-dir resolution for the CLI: NYX_CONFIG_PATH (or
// ./nyx.config.yaml), the zero-config offline fallback (same shape as the
// app server's), and NYX_DATA_DIR (or ~/.nyx).

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { configSchema, loadConfig, type NyxConfig } from "@nyx/config";
import { ConfigError } from "@nyx/config";

/** Env var that overrides the config file location. */
export const CONFIG_PATH_ENV = "NYX_CONFIG_PATH";
/** Env var that overrides the data dir (nyx.db, policy.db live inside). */
export const DATA_DIR_ENV = "NYX_DATA_DIR";
/** Default config path when no env override is present. */
export const DEFAULT_CONFIG_PATH = "nyx.config.yaml";

export interface ResolvedConfig {
  config: NyxConfig;
  /** Where the config came from — used by `nyx doctor` and `config validate`. */
  source: { kind: "file"; path: string } | { kind: "fallback" };
}

/**
 * Load the CLI config: an existing file (env override, else ./nyx.config.yaml)
 * or — when no file exists — the zero-config offline fallback (mock provider,
 * local dev sandbox). A file that exists but is invalid throws ConfigError;
 * the fallback never masks a broken config.
 */
export async function resolveCliConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: { allow_direct_egress?: boolean; allow_unsigned_plugins?: boolean } = {},
): Promise<ResolvedConfig> {
  const path = env[CONFIG_PATH_ENV] ?? DEFAULT_CONFIG_PATH;
  if (existsSync(path)) {
    return {
      config: await loadConfig(path, {
        env,
        ...(opts.allow_direct_egress === true ? { allowDirectEgress: true } : {}),
        ...(opts.allow_unsigned_plugins === true ? { allowUnsignedPlugins: true } : {}),
      }),
      source: { kind: "file", path },
    };
  }
  return { config: fallbackConfig(), source: { kind: "fallback" } };
}

/** The zero-config fallback: mock provider, local dev sandbox, sane policy. */
export function fallbackConfig(): NyxConfig {
  return configSchema.parse({
    providers: { mock: { kind: "mock" } },
    router: { default: { chain: [{ provider: "mock", model: "mock-1" }] } },
    policy: {
      rules: [
        { id: "allow-r0", match: { risk: "R0" }, decision: "allow" },
        { id: "allow-r1", match: { risk: "R1" }, decision: "allow" },
        { id: "ask-r2", match: { risk: "R2" }, decision: "ask" },
        { id: "ask-r3", match: { risk: "R3" }, decision: "ask" },
        { id: "ask-r4", match: { risk: "R4" }, decision: "ask" },
      ],
    },
    sandbox: { provider: "local" },
  });
}

/** The data dir (created if missing): NYX_DATA_DIR or ~/.nyx. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env[DATA_DIR_ENV] ?? join(homedir(), ".nyx");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export { ConfigError };
