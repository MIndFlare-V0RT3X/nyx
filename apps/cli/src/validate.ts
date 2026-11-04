// SPDX-License-Identifier: AGPL-3.0-or-later
// `nyx config validate` — load + validate a config file and report either a
// green OK or the precise failure (file path, YAML line when available,
// dotted field path). A missing file is a clear error, never the fallback.

import { existsSync } from "node:fs";
import { loadConfig, type NyxConfig } from "@nyx/config";
import { ConfigError } from "@nyx/config";

export type ValidateConfigResult =
  { ok: true; config: NyxConfig; path: string } | { ok: false; path: string; message: string };

/**
 * Validate one config file (default ./nyx.config.yaml, or the given path).
 * The failure message is loadConfig's precise multi-line report (it names the
 * file and the offending field paths); a missing file gets its own message.
 */
export async function validateConfigFile(path: string): Promise<ValidateConfigResult> {
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      message: `no config file at ${path} (run "nyx init" to create one)`,
    };
  }
  try {
    const config = await loadConfig(path);
    return { ok: true, config, path };
  } catch (err) {
    const message =
      err instanceof ConfigError
        ? err.message
        : `failed to load ${path}: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, path, message };
  }
}
