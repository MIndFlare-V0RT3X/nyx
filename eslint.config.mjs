// SPDX-License-Identifier: AGPL-3.0-or-later
// Root ESLint flat config. Enforces package dependency direction across the monorepo.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/**
 * Allowed @nyx/* runtime imports per package. Anything not listed is a violation.
 * Tests (*.test.ts) are exempt so they can use real implementations.
 */
const ALLOWED = {
  "packages/protocol": [],
  "packages/config": ["@nyx/protocol"],
  "packages/kernel": ["@nyx/protocol"],
  "packages/session": ["@nyx/protocol"],
  "packages/model": ["@nyx/protocol"],
  "packages/scope": ["@nyx/protocol"],
  "packages/policy": ["@nyx/protocol"],
  "packages/sandbox": ["@nyx/protocol"],
  "packages/memory": ["@nyx/protocol"],
  "packages/persona": ["@nyx/protocol"],
  "packages/tools": ["@nyx/protocol", "@nyx/policy", "@nyx/scope", "@nyx/sandbox"],
  "packages/agent": ["@nyx/protocol"],
  "packages/runtime": ["@nyx/protocol"],
  "packages/channels": ["@nyx/protocol"],
  "packages/db": ["@nyx/protocol", "@nyx/policy", "@nyx/session", "@nyx/channels", "@nyx/runtime"],
  "apps/server": ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/tools", "@nyx/policy", "@nyx/scope", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/agent", "@nyx/runtime", "@nyx/channels", "@nyx/db"],
  "apps/cli": ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/tools", "@nyx/policy", "@nyx/scope", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/agent", "@nyx/db"],
  "apps/web": [],
};

const ALL_PACKAGES = ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/scope", "@nyx/policy", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/tools", "@nyx/agent", "@nyx/runtime", "@nyx/channels", "@nyx/db", "@nyx/server", "@nyx/cli", "@nyx/web"];

const boundaryOverrides = Object.entries(ALLOWED).map(([dir, allowed]) => {
  const forbidden = ALL_PACKAGES.filter((p) => !allowed.includes(p));
  return {
    files: [`${dir}/src/**/*.ts`, `${dir}/src/**/*.tsx`],
    ignores: [`${dir}/src/**/*.test.ts`, `${dir}/src/**/*.test.tsx`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: forbidden.map((p) => ({
            name: p,
            message: `Dependency direction violation: ${dir} may not import ${p}. Allowed: ${allowed.join(", ") || "(none)"}.`,
          })),
        },
      ],
    },
  };
});

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.d.ts", "apps/web/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },
  ...boundaryOverrides,
);
