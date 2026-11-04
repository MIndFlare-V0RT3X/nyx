// SPDX-License-Identifier: AGPL-3.0-or-later
// CVSS 3.1 base scoring — the specification formula (FIRST CVSS v3.1
// Specification, section 7.1), including the scope-dependent Privileges
// Required weights and the Roundup-to-one-decimal rule. Test vectors: the
// published NVD/FIRST vectors in cvss3.test.ts.

export class Cvss3Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cvss3Error";
  }
}

const AV_WEIGHTS: Readonly<Record<string, number>> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_WEIGHTS: Readonly<Record<string, number>> = { L: 0.77, H: 0.44 };
/** PR weights depend on Scope (the cross-trust-boundary adjustment). */
const PR_WEIGHTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  U: { N: 0.85, L: 0.62, H: 0.27 },
  C: { N: 0.85, L: 0.68, H: 0.5 },
};
const UI_WEIGHTS: Readonly<Record<string, number>> = { N: 0.85, R: 0.62 };
const CIA_WEIGHTS: Readonly<Record<string, number>> = { H: 0.56, L: 0.22, N: 0 };

export interface Cvss3Metrics {
  AV: string;
  AC: string;
  PR: string;
  UI: string;
  S: string;
  C: string;
  I: string;
  A: string;
}

/** Parse a CVSS 3.1 vector string into its eight base metrics. */
export function parseCvss3(vector: string): Cvss3Metrics {
  const parts = vector.split("/");
  if (parts[0] !== "CVSS:3.1") {
    throw new Cvss3Error('CVSS 3.1 vector must start with "CVSS:3.1"');
  }
  const allowed: Readonly<Record<string, string[]>> = {
    AV: ["N", "A", "L", "P"],
    AC: ["L", "H"],
    PR: ["N", "L", "H"],
    UI: ["N", "R"],
    S: ["U", "C"],
    C: ["H", "L", "N"],
    I: ["H", "L", "N"],
    A: ["H", "L", "N"],
  };
  const metrics: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    if (part === "") continue;
    const sep = part.indexOf(":");
    if (sep <= 0) throw new Cvss3Error(`invalid vector segment "${part}"`);
    const name = part.slice(0, sep);
    const value = part.slice(sep + 1);
    if (allowed[name] === undefined) throw new Cvss3Error(`unknown CVSS 3.1 metric "${name}"`);
    if (metrics[name] !== undefined) throw new Cvss3Error(`duplicated metric "${name}"`);
    if (!allowed[name]!.includes(value)) {
      throw new Cvss3Error(`invalid value "${value}" for metric ${name}`);
    }
    metrics[name] = value;
  }
  for (const name of Object.keys(allowed)) {
    if (metrics[name] === undefined) throw new Cvss3Error(`missing mandatory base metric ${name}`);
  }
  return metrics as unknown as Cvss3Metrics;
}

/** The spec's Roundup: the smallest 1-decimal number ≥ the input. */
function roundup(input: number): number {
  // Guard floating-point noise before the ceiling (8.6 - 7.15 style artifacts).
  const stabilized = Math.round(input * 1e8) / 1e8;
  return Math.ceil(stabilized * 10) / 10;
}

/** The CVSS 3.1 base score for a parsed vector (0–10, one decimal). */
export function scoreCvss3(metrics: Cvss3Metrics): number {
  const scope = metrics.S === "C" ? "C" : "U";
  const iss = 1 -
    (1 - CIA_WEIGHTS[metrics.C]!) *
    (1 - CIA_WEIGHTS[metrics.I]!) *
    (1 - CIA_WEIGHTS[metrics.A]!);
  const impact =
    scope === "U"
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  if (impact <= 0) return 0;
  const exploitability =
    8.22 *
    AV_WEIGHTS[metrics.AV]! *
    AC_WEIGHTS[metrics.AC]! *
    PR_WEIGHTS[scope]![metrics.PR]! *
    UI_WEIGHTS[metrics.UI]!;
  const base =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);
  return roundup(base);
}

/** Score a CVSS 3.1 vector string. Throws Cvss3Error on malformed input. */
export function scoreCvss3Vector(vector: string): number {
  return scoreCvss3(parseCvss3(vector));
}
