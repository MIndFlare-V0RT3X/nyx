#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// The release SPDX audit (Phase 7.5): every source file carries the license
// header. Exit 1 with the offender list on any miss. Files that are not
// source (JSON, YAML fixtures, lockfiles) are out of scope — the LICENSE
// and the headers are the claim.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".mjs", ".js"]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".git",
  ".turbo",
  "coverage",
  "fixtures", // captured third-party tool output, not our source
]);
const HEADER = "SPDX-License-Identifier:";

const offenders = [];
let checked = 0;

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name));
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf("."));
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    const file = join(dir, entry.name);
    const text = await readFile(file, "utf8");
    checked += 1;
    if (!text.slice(0, 400).includes(HEADER)) {
      offenders.push(file);
    }
  }
}

await walk(process.cwd());
if (offenders.length > 0) {
  console.error(`SPDX audit: ${offenders.length} of ${checked} source files lack the header:`);
  for (const file of offenders) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`SPDX audit: all ${checked} source files carry the AGPL-3.0-or-later header.`);
