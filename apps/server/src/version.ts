// SPDX-License-Identifier: AGPL-3.0-or-later
// The server's own version identity: workspace package version + brand.
// Read once at module load from this package's package.json (src/ and dist/
// both sit one level below it); a hardcoded fallback keeps the module usable
// if the file is missing (e.g. a bundled deployment).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND } from "@nyx/config";

const FALLBACK_VERSION = "0.7.1";

function readVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.length > 0) return pkg.version;
  } catch {
    // unreadable or malformed package.json: keep the fallback
  }
  return FALLBACK_VERSION;
}

/** The @nyx/server workspace package version. */
export const SERVER_VERSION: string = readVersion();

/** Brand + version, e.g. "nyx/0.7.1" — the health endpoint's `version` field. */
export const SERVER_ID: string = `${BRAND.name}/${SERVER_VERSION}`;
