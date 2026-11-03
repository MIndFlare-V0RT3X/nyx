// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // src/harness.test.ts is a shared test HELPER, not a suite: it is named
    // *.test.ts so the root eslint config's package-boundary exemption for
    // test files applies (only tests may import the sibling @nyx packages),
    // and it registers no tests, so vitest must not run it.
    exclude: ["**/node_modules/**", "**/dist/**", "src/harness.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
});
