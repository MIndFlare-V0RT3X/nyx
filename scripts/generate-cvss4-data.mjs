#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerates packages/security/src/findings/cvss4-data.ts from the official
// FIRST / RedHatProductSecurity reference calculator (BSD-2-Clause):
//   https://github.com/RedHatProductSecurity/cvss-v4-calculator
//
// Usage: node scripts/generate-cvss4-data.mjs [path-to-cvss40.js]
// Without an argument the reference is fetched from the canonical URL. The
// generated file must NOT be hand-edited — rerun this script instead. Keys
// stay QUOTED: leading-zero macrovector digits are strings, not numbers.

import { writeFile } from "node:fs/promises";
import { argv } from "node:process";

const DEFAULT_URL =
  "https://raw.githubusercontent.com/RedHatProductSecurity/cvss-v4-calculator/main/cvss40.js";

async function main(): Promise<void> {
  const source =
    argv[2] !== undefined ? await (await import("node:fs/promises")).readFile(argv[2], "utf8") : await (await fetch(DEFAULT_URL)).text();

  // Extract the CVSS40 class statics by evaluating the reference in a module
  // sandbox (it is plain browser/node-safe JS).
  const module_ = { exports: {} };
  const fn = new Function("module", "exports", "window", source);
  fn(module_, module_.exports, undefined);
  const { CVSS40 } = module_.exports;
  if (CVSS40 === undefined) throw new Error("could not extract CVSS40 from the reference");

  const data = {
    LOOKUP_TABLE: CVSS40.LOOKUP_TABLE,
    MAX_COMPOSED: CVSS40.MAX_COMPOSED,
    MAX_SEVERITY: CVSS40.MAX_SEVERITY,
    METRIC_LEVELS: CVSS40.METRIC_LEVELS,
  };

  const lines = [
    "// SPDX-License-Identifier: AGPL-3.0-or-later",
    "// CVSS 4.0 scoring data — generated verbatim from the official FIRST /",
    "// RedHatProductSecurity reference calculator (cvss40.js, BSD-2-Clause:",
    "// https://github.com/RedHatProductSecurity/cvss-v4-calculator). The",
    "// tables are normative spec data (CVSS v4.0 Specification, FIRST.org);",
    "// keys stay QUOTED (leading-zero macrovector digits are strings, not",
    "// numbers). Regenerate with scripts/generate-cvss4-data.mjs.",
    "",
    "/** MacroVector (EQ1..EQ6 digits) → pre-computed equivalent-class score. */",
    `export const CVSS4_LOOKUP_TABLE: Readonly<Record<string, number>> = ${JSON.stringify(data.LOOKUP_TABLE, null, 2)} as const;`,
    "",
    "/** The highest-severity vector parts per EQ class. */",
    `export const CVSS4_MAX_COMPOSED: Readonly<Record<string, Record<string, string[] | Record<string, string[]>>>> = ${JSON.stringify(data.MAX_COMPOSED, null, 2)} as const;`,
    "",
    "/** Max severity distances per EQ MacroVector (+1). */",
    `export const CVSS4_MAX_SEVERITY: Readonly<Record<string, Record<string, number | Record<string, number>>>> = ${JSON.stringify(data.MAX_SEVERITY, null, 2)} as const;`,
    "",
    "/** Metric value indices for severity-distance computation. */",
    `export const CVSS4_METRIC_LEVELS: Readonly<Record<string, Record<string, number>>> = ${JSON.stringify(data.METRIC_LEVELS, null, 2)} as const;`,
    "",
  ];
  const out = "packages/security/src/findings/cvss4-data.ts";
  await writeFile(out, lines.join("\n"), "utf8");
  console.log(`wrote ${out} (${Object.keys(data.LOOKUP_TABLE).length} lookup entries)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
