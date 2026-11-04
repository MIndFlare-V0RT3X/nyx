// SPDX-License-Identifier: AGPL-3.0-or-later
// `--engagement <file>` loading (Phase 5: YAML engagement files via
// @nyx/security). JSON still loads — YAML is a superset — so existing
// one-shot scripts keep working. The loaded snapshot is what the session
// binds; warnings (e.g. domain-only authorization) surface on stderr.

import { loadEngagementYaml, EngagementFileError, type LoadedEngagement } from "@nyx/security";
import { CliError } from "./errors.js";

export type { LoadedEngagement };

export async function loadEngagementFile(
  path: string,
  now: () => number = Date.now,
): Promise<LoadedEngagement> {
  try {
    const loaded = await loadEngagementYaml(path, { now });
    for (const warning of loaded.warnings) {
      console.warn(`engagement warning: ${warning}`);
    }
    return loaded;
  } catch (err) {
    if (err instanceof EngagementFileError) {
      throw new CliError("validation_failed", err.message);
    }
    throw err;
  }
}
