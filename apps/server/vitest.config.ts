// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Integration suites build real runtimes (sqlite WAL+FULL fsync, sandbox
    // forks, loopback servers): seconds on a fast CI box, 3–5× that on WSL2.
    // A 30s ceiling converted slow machines into flakes (v0.7.3); 120s is a
    // machine budget, not a correctness bound.
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
  },
});
