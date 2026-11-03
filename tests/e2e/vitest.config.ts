// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
