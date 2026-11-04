// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/harness.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
});
