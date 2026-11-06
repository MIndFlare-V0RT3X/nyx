// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["*.test.ts"],
    environment: "node",
    // Split-process boots + real turns: fast on CI, 3–5× that on WSL2. The
    // old 60s ceiling left thin margins on slow machines (v0.7.3); 120s is
    // a machine budget, not a correctness bound.
    testTimeout: 120000,
    hookTimeout: 120000,
    passWithNoTests: true,
  },
});
