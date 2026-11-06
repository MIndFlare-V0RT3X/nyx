#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Repo hygiene gate: every workspace `bin` entry must point at a file git
// tracks — never at build output.
//
// Why this exists: pnpm links a package's bins into dependents'
// node_modules/.bin at INSTALL time, before `pnpm build` has produced
// dist/. A bin aimed at dist/*.js makes every fresh install print
//   WARN Failed to create bin at ... ENOENT: no such file or directory
// and leaves the shim missing — pnpm never retries after the build
// (reported by a first-run user against v0.7.1). Committed launcher
// stubs are the fix (apps/split/bin/, apps/cli/bin/); this check is the
// tripwire that keeps it fixed. Run from a git checkout of the repo.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Workspace layout mirrors pnpm-workspace.yaml: packages/*, apps/*,
// tests/e2e, tests/evals, plus the root manifest.
const packageDirs = ["."];
for (const scope of ["apps", "packages", "tests"]) {
  const scopeDir = join(root, scope);
  if (!existsSync(scopeDir)) continue;
  for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
    if (entry.isDirectory()) packageDirs.push(join(scope, entry.name));
  }
}

let checked = 0;
const failures = [];
for (const dir of packageDirs) {
  const manifestPath = join(root, dir, "package.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest.bin) continue;
  const bins =
    typeof manifest.bin === "string"
      ? { [manifest.name ?? dir]: manifest.bin }
      : manifest.bin;
  for (const [name, target] of Object.entries(bins)) {
    checked += 1;
    const abs = resolve(root, dir, target);
    if (!existsSync(abs)) {
      failures.push(`${name} -> ${target}: target does not exist (${dir}/package.json)`);
      continue;
    }
    const rel = relative(root, abs);
    const tracked = execFileSync("git", ["ls-files", "--", rel], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (tracked === "") {
      failures.push(
        `${name} -> ${target}: exists but is not git-tracked — bins must point at ` +
          `committed files, not build output (${dir}/package.json)`,
      );
    }
  }
}

if (failures.length > 0) {
  console.error(`check-bins: ${failures.length} problem(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`check-bins: ${checked}/${checked} workspace bin entries point at committed files.`);
