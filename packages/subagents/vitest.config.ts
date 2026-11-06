// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/harness.test.ts"],
    environment: "node",
    // Fork-per-child suites cp -a real sandboxes per spawn: fast on CI, 3–5×
    // slower on WSL2. A 30s ceiling converted slow machines into flakes
    // (v0.7.3); 120s is a machine budget, not a correctness bound.
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
  },
});
