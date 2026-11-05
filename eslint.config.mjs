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
  "packages/sandbox": ["@nyx/protocol", "@nyx/scope"],
  "packages/memory": ["@nyx/protocol"],
  "packages/persona": ["@nyx/protocol"],
  "packages/tools": ["@nyx/protocol", "@nyx/policy", "@nyx/scope", "@nyx/sandbox"],
  "packages/agent": ["@nyx/protocol"],
  "packages/runtime": ["@nyx/protocol"],
  "packages/channels": ["@nyx/protocol", "@nyx/policy"],
  "packages/db": ["@nyx/protocol", "@nyx/policy", "@nyx/session", "@nyx/channels", "@nyx/runtime"],
  "packages/skills": ["@nyx/protocol"],
  "packages/subagents": ["@nyx/protocol", "@nyx/policy", "@nyx/sandbox", "@nyx/tools", "@nyx/agent"],
  "packages/tasks": ["@nyx/protocol", "@nyx/policy", "@nyx/session", "@nyx/runtime"],
  "packages/security": ["@nyx/protocol", "@nyx/scope", "@nyx/sandbox", "@nyx/tools"],
  "apps/server": ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/tools", "@nyx/policy", "@nyx/scope", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/agent", "@nyx/runtime", "@nyx/channels", "@nyx/db", "@nyx/skills", "@nyx/subagents", "@nyx/tasks", "@nyx/security"],
  "apps/cli": ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/tools", "@nyx/policy", "@nyx/scope", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/agent", "@nyx/db", "@nyx/skills", "@nyx/subagents", "@nyx/tasks", "@nyx/security"],
  "apps/web": [],
};

const ALL_PACKAGES = ["@nyx/protocol", "@nyx/config", "@nyx/kernel", "@nyx/session", "@nyx/model", "@nyx/scope", "@nyx/policy", "@nyx/sandbox", "@nyx/memory", "@nyx/persona", "@nyx/tools", "@nyx/agent", "@nyx/runtime", "@nyx/channels", "@nyx/db", "@nyx/skills", "@nyx/subagents", "@nyx/tasks", "@nyx/security", "@nyx/server", "@nyx/cli", "@nyx/web"];

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
    // Repo scripts and the plugin template's helper scripts are Node ESM
    // with the standard globals.
    files: ["scripts/**/*.mjs", "templates/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        fetch: "readonly",
        URL: "readonly",
        Buffer: "readonly",
      },
    },
  },
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
