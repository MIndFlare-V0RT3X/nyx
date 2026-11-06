// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  // ink 5.x ships no testing-library subpath, so the TUI is tested through the
  // headless chat driver (src/chat-state.ts); .tsx still compiles for the view.
  esbuild: { jsx: "automatic" },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // src/harness.test.ts is a shared test HELPER, not a suite: it is named
    // *.test.ts so the root eslint config's package-boundary exemption for
    // test files applies, and it registers no tests, so vitest must not run it.
    exclude: ["**/node_modules/**", "**/dist/**", "src/harness.test.ts"],
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
