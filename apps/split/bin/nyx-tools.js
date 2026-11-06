#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Committed bin launcher for nyx-tools (the untrusted split process).
//
// pnpm links a package's `bin` entries into dependents' node_modules/.bin
// at INSTALL time — before `pnpm build` has produced dist/. While the
// entries pointed straight at dist/tools-main.js, every fresh install
// printed
//   WARN Failed to create bin at .../node_modules/.bin/nyx-tools.
//   ENOENT: no such file or directory, open '.../apps/split/dist/tools-main.js'
// and the shim stayed missing — pnpm never retries after the build
// (reported by a first-run user against v0.7.1). This launcher is a
// committed file, so the linker always finds it; it exec's the build
// output at runtime.
//
// tools-main runs main() at module load and blocks until signalled, so
// the launcher SPAWNS the entry — importing it would boot the tools
// process inside the launcher process. scripts/check-bins.mjs keeps every
// workspace bin pointing at a committed file.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const entry = join(import.meta.dirname, "..", "dist", "tools-main.js");

if (!existsSync(entry)) {
  process.stderr.write(
    `nyx-tools: build output not found at ${entry}\n` +
      "  The split entrypoints are TypeScript build outputs — run\n" +
      "  `pnpm install && pnpm build` in the repository root first.\n",
  );
  process.exit(1);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 1));
