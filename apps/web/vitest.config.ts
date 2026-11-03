// SPDX-License-Identifier: AGPL-3.0-or-later

export default {
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    passWithNoTests: true,
  },
};
