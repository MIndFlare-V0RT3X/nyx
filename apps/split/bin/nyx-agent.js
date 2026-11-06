#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Committed bin launcher for nyx-agent (the semi-trusted split process).
//
// pnpm links a package's `bin` entries into dependents' node_modules/.bin
// at INSTALL time — before `pnpm build` has produced dist/. While the
// entries pointed straight at dist/agent-main.js, every fresh install
// printed
//   WARN Failed to create bin at .../node_modules/.bin/nyx-agent.
//   ENOENT: no such file or directory, open '.../apps/split/dist/agent-main.js'
// and the shim stayed missing — pnpm never retries after the build
// (reported by a first-run user against v0.7.1). This launcher is a
// committed file, so the linker always finds it; it exec's the build
// output at runtime.
//
// agent-main only auto-runs when process.argv[1] ends with
// "agent-main.js" (its import-by-tests guard), so the launcher SPAWNS the
// entry — importing it would satisfy neither the guard nor the operator.
// scripts/check-bins.mjs keeps every workspace bin pointing at a
// committed file.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const entry = join(import.meta.dirname, "..", "dist", "agent-main.js");

if (!existsSync(entry)) {
  process.stderr.write(
    `nyx-agent: build output not found at ${entry}\n` +
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
