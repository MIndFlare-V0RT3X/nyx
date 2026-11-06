#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Committed bin launcher for the nyx CLI.
//
// pnpm links a package's `bin` entries into dependents' node_modules/.bin
// at INSTALL time — before `pnpm build` has produced dist/. While the
// entry pointed straight at dist/main.js, any workspace that grows a
// dependency on @nyx/cli (or any `pnpm link` install) would hit the same
// install-time ENOENT the split bins did on v0.7.1:
//   WARN Failed to create bin at .../node_modules/.bin/nyx.
//   ENOENT: no such file or directory, open '.../apps/cli/dist/main.js'
// This launcher is a committed file, so the linker always finds it; it
// exec's the build output at runtime. scripts/check-bins.mjs keeps every
// workspace bin pointing at a committed file.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const entry = join(import.meta.dirname, "..", "dist", "main.js");

if (!existsSync(entry)) {
  process.stderr.write(
    `nyx: build output not found at ${entry}\n` +
      "  The CLI is a TypeScript build output — run\n" +
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
