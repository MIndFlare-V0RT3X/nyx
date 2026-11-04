// SPDX-License-Identifier: AGPL-3.0-or-later
// CVSS 4.0 base scoring — a faithful TypeScript port of the official FIRST /
// RedHatProductSecurity reference calculator (cvss40.js, BSD-2-Clause),
// including the MacroVector lookup, the next-lower-macro interpolation, and
// the round-half-up-to-one-decimal behavior. Test vectors: the published
// FIRST CVSS v4.0 Examples document (see cvss4.test.ts).

import {
  CVSS4_LOOKUP_TABLE,
  CVSS4_MAX_COMPOSED,
  CVSS4_MAX_SEVERITY,
  CVSS4_METRIC_LEVELS,
} from "./cvss4-data.js";

/** The 11 mandatory base metrics. */
const BASE_METRICS = ["AV", "AC", "AT", "PR", "UI", "VC", "VI", "VA", "SC", "SI", "SA"] as const;

/** All metric names the parser accepts (base + threat + environmental). */
const ALL_METRICS: Readonly<Record<string, string[]>> = {
  AV: ["N", "A", "L", "P"],
  AC: ["L", "H"],
  AT: ["N", "P"],
  PR: ["N", "L", "H"],
  UI: ["N", "P", "A"],
  VC: ["N", "L", "H"],
  VI: ["N", "L", "H"],
  VA: ["N", "L", "H"],
  SC: ["N", "L", "H"],
  SI: ["N", "L", "H"],
  SA: ["N", "L", "H"],
  E: ["X", "A", "P", "U"],
  CR: ["X", "H", "M", "L"],
  IR: ["X", "H", "M", "L"],
  AR: ["X", "H", "M", "L"],
  MAV: ["X", "N", "A", "L", "P"],
  MAC: ["X", "L", "H"],
  MAT: ["X", "N", "P"],
  MPR: ["X", "N", "L", "H"],
  MUI: ["X", "N", "P", "A"],
  MVC: ["X", "N", "L", "H"],
  MVI: ["X", "N", "L", "H"],
  MVA: ["X", "N", "L", "H"],
  MSC: ["X", "N", "L", "H"],
  MSI: ["X", "S", "H", "L", "N"],
  MSA: ["X", "S", "H", "L", "N"],
};

/** Worst-case defaults for `X` (spec: E:X → A; CR/IR/AR:X → H). */
const WORST_CASE_DEFAULTS: Readonly<Record<string, string>> = {
  E: "A",
  CR: "H",
  IR: "H",
  AR: "H",
};

export class Cvss4Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cvss4Error";
  }
}

function roundToDecimalPlaces(value: number): number {
  // The reference's EPSILON-guarded round-half-up to one decimal.
  const epsilon = Math.pow(10, -6);
  return Math.round((value + epsilon) * 10) / 10;
}

/** A parsed CVSS 4.0 vector. */
export class Cvss4Vector {
  private readonly metrics: Record<string, string>;

  constructor(vector: string) {
    this.metrics = {};
    const parts = vector.split("/");
    if (parts[0] !== "CVSS:4.0") {
      throw new Cvss4Error('CVSS 4.0 vector must start with "CVSS:4.0"');
    }
    const seen = new Set<string>();
    for (const part of parts.slice(1)) {
      if (part === "") continue;
      const sep = part.indexOf(":");
      if (sep <= 0) throw new Cvss4Error(`invalid vector segment "${part}"`);
      const name = part.slice(0, sep);
      const value = part.slice(sep + 1);
      const allowed = ALL_METRICS[name];
      if (allowed === undefined) throw new Cvss4Error(`unknown CVSS 4.0 metric "${name}"`);
      if (!allowed.includes(value)) {
        throw new Cvss4Error(`invalid value "${value}" for metric ${name}`);
      }
      if (seen.has(name)) throw new Cvss4Error(`duplicated metric "${name}"`);
      seen.add(name);
      this.metrics[name] = value;
    }
    for (const base of BASE_METRICS) {
      if (!seen.has(base)) throw new Cvss4Error(`missing mandatory base metric ${base}`);
    }
  }

  /** Effective value: worst-case defaults for X, environmental M-overrides. */
  effective(metric: string): string {
    // Absent optional metrics are "X" (the reference pre-fills defaults).
    const raw = this.metrics[metric] ?? "X";
    if (raw === "X" && WORST_CASE_DEFAULTS[metric] !== undefined) {
      return WORST_CASE_DEFAULTS[metric]!;
    }
    const modified = `M${metric}`;
    const modRaw = this.metrics[modified];
    if (modRaw !== undefined && modRaw !== "X") {
      return modRaw;
    }
    return raw;
  }

  /** The six equivalent classes, as a digit string (e.g. "002201"). */
  equivalentClasses(): string {
    const eq1 = (): string => {
      const av = this.effective("AV");
      const pr = this.effective("PR");
      const ui = this.effective("UI");
      if (av === "N" && pr === "N" && ui === "N") return "0";
      if ((av === "N" || pr === "N" || ui === "N") && av !== "P") return "1";
      return "2";
    };
    const eq2 = (): string =>
      this.effective("AC") === "L" && this.effective("AT") === "N" ? "0" : "1";
    const eq3 = (): string => {
      const vc = this.effective("VC");
      const vi = this.effective("VI");
      const va = this.effective("VA");
      if (vc === "H" && vi === "H") return "0";
      if (vc === "H" || vi === "H" || va === "H") return "1";
      return "2";
    };
    const eq4 = (): string => {
      const msi = this.effective("MSI");
      const msa = this.effective("MSA");
      if (msi === "S" || msa === "S") return "0";
      if (
        this.effective("SC") === "H" ||
        this.effective("SI") === "H" ||
        this.effective("SA") === "H"
      ) {
        return "1";
      }
      return "2";
    };
    const eq5 = (): string => {
      const e = this.effective("E");
      return e === "A" ? "0" : e === "P" ? "1" : "2";
    };
    const eq6 = (): string => {
      // EQ6 is 0 when a HIGH requirement meets a HIGH impact (the value is
      // already reflected in EQ3); 1 otherwise.
      if (
        (this.effective("CR") === "H" && this.effective("VC") === "H") ||
        (this.effective("IR") === "H" && this.effective("VI") === "H") ||
        (this.effective("AR") === "H" && this.effective("VA") === "H")
      ) {
        return "0";
      }
      return "1";
    };
    return eq1() + eq2() + eq3() + eq4() + eq5() + eq6();
  }

  /** Severity distances of this vector from a max-severity vector. */
  private severityDistances(maxVector: string): Record<string, number> {
    const distances: Record<string, number> = {};
    for (const metric of Object.keys(CVSS4_METRIC_LEVELS)) {
      const mine = CVSS4_METRIC_LEVELS[metric]![this.effective(metric)]!;
      const max = CVSS4_METRIC_LEVELS[metric]![extractValueMetric(metric, maxVector)]!;
      distances[metric] = mine - max;
    }
    return distances;
  }

  private maxSeverityVectorsFor(eq: 1 | 2 | 3 | 4 | 5, macro: string): string[] {
    const table = CVSS4_MAX_COMPOSED[`eq${eq}`]!;
    const entry = table[macro[eq - 1]!] as string[] | Record<string, string[]>;
    if (eq === 3) {
      // eq3 is keyed by eq6 for the combination.
      return (entry as Record<string, string[]>)[macro.charAt(5)] ?? [];
    }
    return entry as string[];
  }

  /** The CVSS 4.0 score for this vector (0–10, one decimal). */
  score(): number {
    const NO_IMPACT = ["VC", "VI", "VA", "SC", "SI", "SA"];
    if (NO_IMPACT.every((m) => this.effective(m) === "N")) return 0.0;

    const macro = this.equivalentClasses();
    const value = CVSS4_LOOKUP_TABLE[macro];
    if (value === undefined) {
      throw new Cvss4Error(`no CVSS 4.0 lookup entry for macrovector ${macro}`);
    }
    const eq1 = Number(macro.charAt(0));
    const eq2 = Number(macro.charAt(1));
    const eq3 = Number(macro.charAt(2));
    const eq4 = Number(macro.charAt(3));
    const eq5 = Number(macro.charAt(4));
    const eq6 = Number(macro.charAt(5));

    const next = (s: string): number => {
      const v = CVSS4_LOOKUP_TABLE[s];
      return v === undefined ? Number.NaN : v;
    };
    const nextLower = (i: number, digit: number): string => {
      const chars = macro.split("");
      chars[i] = String(digit);
      return chars.join("");
    };

    // eq3 and eq6 are related — special next-lower combinations.
    let scoreEq3eq6Next: number;
    if (eq3 === 0 && eq6 === 0) {
      // 00 --> 01 and 00 --> 10; multiple paths, take the higher score.
      scoreEq3eq6Next = Math.max(next(nextLower(5, 1)), next(nextLower(2, 1)));
    } else if (eq3 === 1 && eq6 === 0) {
      // 10 --> 11
      scoreEq3eq6Next = next(nextLower(5, 1));
    } else if (eq3 === 0 || eq3 === 1) {
      // 01 --> 11 and 11 --> 21
      scoreEq3eq6Next = next(nextLower(2, 1));
    } else {
      // 21/20 --> 32 (does not exist — NaN, skipped downstream)
      scoreEq3eq6Next = next(`${eq1}${eq2}${eq3 + 1}${eq4}${eq5}${eq6 + 1}`);
    }

    const available = {
      eq1: value - next(nextLower(0, eq1 + 1)),
      eq2: value - next(nextLower(1, eq2 + 1)),
      eq3eq6: value - scoreEq3eq6Next,
      eq4: value - next(nextLower(3, eq4 + 1)),
      eq5: value - next(nextLower(4, eq5 + 1)),
    };

    // The highest-severity vectors for this macrovector — compose them and
    // pick the first whose severity distances are all non-negative.
    const eqMaxes = [
      this.maxSeverityVectorsFor(1, macro),
      this.maxSeverityVectorsFor(2, macro),
      this.maxSeverityVectorsFor(3, macro),
      this.maxSeverityVectorsFor(4, macro),
      this.maxSeverityVectorsFor(5, macro),
    ];
    let distances: Record<string, number> = {};
    outer: for (const m1 of eqMaxes[0]!) {
      for (const m2 of eqMaxes[1]!) {
        for (const m3 of eqMaxes[2]!) {
          for (const m4 of eqMaxes[3]!) {
            for (const m5 of eqMaxes[4]!) {
              const d = this.severityDistances(m1 + m2 + m3 + m4 + m5);
              if (Object.values(d).every((x) => x >= 0)) {
                distances = d;
                break outer;
              }
              distances = d;
            }
          }
        }
      }
    }

    const step = 0.1;
    const maxSeverity = {
      eq1: (CVSS4_MAX_SEVERITY["eq1"]![eq1] as number) * step,
      eq2: (CVSS4_MAX_SEVERITY["eq2"]![eq2] as number) * step,
      eq3eq6: ((CVSS4_MAX_SEVERITY["eq3eq6"]![eq3] as Record<string, number>)[eq6] ?? 0) * step,
      eq4: (CVSS4_MAX_SEVERITY["eq4"]![eq4] as number) * step,
    };

    const current = {
      eq1: distances["AV"]! + distances["PR"]! + distances["UI"]!,
      eq2: distances["AC"]! + distances["AT"]!,
      eq3eq6:
        distances["VC"]! + distances["VI"]! + distances["VA"]! +
        distances["CR"]! + distances["IR"]! + distances["AR"]!,
      eq4: distances["SC"]! + distances["SI"]! + distances["SA"]!,
    };

    let n = 0;
    let sum = 0;
    const consider = (avail: number, ratio: number): void => {
      if (!Number.isNaN(avail)) {
        n += 1;
        sum += avail * ratio;
      }
    };
    consider(available.eq1, maxSeverity.eq1 === 0 ? 0 : current.eq1 / maxSeverity.eq1);
    consider(available.eq2, maxSeverity.eq2 === 0 ? 0 : current.eq2 / maxSeverity.eq2);
    consider(available.eq3eq6, maxSeverity.eq3eq6 === 0 ? 0 : current.eq3eq6 / maxSeverity.eq3eq6);
    consider(available.eq4, maxSeverity.eq4 === 0 ? 0 : current.eq4 / maxSeverity.eq4);
    consider(available.eq5, 0); // EQ5's proportion is always 0.

    const meanDistance = n === 0 ? 0 : sum / n;
    return roundToDecimalPlaces(Math.max(0, Math.min(10, value - meanDistance)));
  }
}

/** Extract one metric's value from a composed max-vector string. */
function extractValueMetric(metric: string, str: string): string {
  const index = str.indexOf(metric) + metric.length + 1;
  if (index < metric.length + 1) return "N";
  const extracted = str.slice(index);
  const slash = extracted.indexOf("/");
  return slash > 0 ? extracted.slice(0, slash) : extracted;
}

/** Score a CVSS 4.0 vector string. Throws Cvss4Error on malformed input. */
export function scoreCvss4(vector: string): number {
  return new Cvss4Vector(vector).score();
}
