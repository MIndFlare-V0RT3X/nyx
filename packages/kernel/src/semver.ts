// SPDX-License-Identifier: AGPL-3.0-or-later
// Minimal semver range checker used for plugin/kernel version compatibility.
// Deliberately small: `*`, exact `1.2.3`, `^`, `~`, the four comparators,
// space-separated AND, `||` OR, and combinations. Anything it cannot parse is
// DENIED (returns false) — a malformed range must never grant compatibility.
//
// Known, documented deviations from node-semver: no hyphen ranges, no
// wildcards combined with operators (`>=1.2.x` is invalid), an empty `||`
// alternative is invalid rather than `*`, and there is no prerelease-exclusion
// rule (prerelease versions order normally, so `0.2.0-rc.1` satisfies
// `>=0.1.0`).

/** Parsed semver. Build metadata is ignored (semver: comparisons ignore it). */
interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

type Op = ">=" | ">" | "<" | "<=" | "=";

interface Comparator {
  op: Op;
  version: SemVer;
}

/** A possibly-partial version: `1`, `1.2`, `1.2.3`, `1.x`, `1.2.x`, `*`. */
interface PartialVersion {
  major: number | "*";
  minor: number | "*";
  patch: number | "*";
  /** Present only when all three components are concrete. */
  prerelease?: string[];
}

const NUM = "0|[1-9][0-9]*";
const IDENT = "[0-9A-Za-z-]+";
const VERSION_RE = new RegExp(
  `^v?(${NUM})\\.(${NUM})\\.(${NUM})` +
    `(?:-(${IDENT}(?:\\.${IDENT})*))?` +
    `(?:\\+${IDENT}(?:\\.${IDENT})*)?$`,
);

function parsePrerelease(raw: string | undefined): string[] | null {
  if (raw === undefined) return [];
  const ids: string[] = [];
  for (const id of raw.split(".")) {
    // Numeric identifiers must not carry leading zeros (semver §9).
    if (/^\d+$/.test(id) && !/^(0|[1-9][0-9]*)$/.test(id)) return null;
    ids.push(id);
  }
  return ids;
}

function parseVersion(input: string): SemVer | null {
  const m = VERSION_RE.exec(input);
  if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  const prerelease = parsePrerelease(m[4]);
  if (prerelease === null) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease };
}

function parsePartial(input: string): PartialVersion | null {
  // Strip build metadata; comparisons ignore it.
  const plus = input.indexOf("+");
  const withoutBuild = plus === -1 ? input : input.slice(0, plus);
  // Split a prerelease suffix off the last component.
  let body = withoutBuild;
  let prereleaseRaw: string | undefined;
  const dash = withoutBuild.indexOf("-");
  if (dash !== -1) {
    prereleaseRaw = withoutBuild.slice(dash + 1);
    body = withoutBuild.slice(0, dash);
  }
  const parts = body.split(".");
  if (parts.length === 0 || parts.length > 3) return null;
  const nums: Array<number | "*"> = [];
  let sawWildcard = false;
  for (const part of parts) {
    if (part === "x" || part === "X" || part === "*") {
      sawWildcard = true;
      nums.push("*");
    } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
      if (sawWildcard) return null; // wildcards must be trailing: 1.x.3 is invalid
      nums.push(Number(part));
    } else {
      return null;
    }
  }
  if (prereleaseRaw !== undefined) {
    if (sawWildcard || nums.length !== 3) return null;
    const prerelease = parsePrerelease(prereleaseRaw);
    if (prerelease === null) return null;
    const [major, minor, patch] = nums;
    if (major === undefined || minor === undefined || patch === undefined) return null;
    if (major === "*" || minor === "*" || patch === "*") return null;
    return { major, minor, patch, prerelease };
  }
  return { major: nums[0] ?? "*", minor: nums[1] ?? "*", patch: nums[2] ?? "*" };
}

/** Exclusive upper bound `<major.minor.patch-0`: excludes the boundary and its prereleases. */
function upperBound(major: number, minor: number, patch: number): Comparator {
  return { op: "<", version: { major, minor, patch, prerelease: ["0"] } };
}

function lowerBound(p: PartialVersion): Comparator {
  return {
    op: ">=",
    version: {
      major: p.major === "*" ? 0 : p.major,
      minor: p.minor === "*" ? 0 : p.minor,
      patch: p.patch === "*" ? 0 : p.patch,
      prerelease: p.prerelease ?? [],
    },
  };
}

/** `^`: allow changes that do not modify the leftmost nonzero component. */
function caret(p: PartialVersion): Comparator[] {
  if (p.major === "*") return [];
  if (p.major > 0) return [lowerBound(p), upperBound(p.major + 1, 0, 0)];
  if (p.minor === "*") return [lowerBound(p), upperBound(1, 0, 0)];
  if (p.minor > 0) return [lowerBound(p), upperBound(0, p.minor + 1, 0)];
  if (p.patch === "*") return [lowerBound(p), upperBound(0, 1, 0)];
  return [lowerBound(p), upperBound(0, 0, p.patch + 1)];
}

/** `~`: allow patch-level changes when a minor is given, else minor-level. */
function tilde(p: PartialVersion): Comparator[] {
  if (p.major === "*") return [];
  if (p.minor === "*") return [lowerBound(p), upperBound(p.major + 1, 0, 0)];
  return [lowerBound(p), upperBound(p.major, p.minor + 1, 0)];
}

/** Bare token: exact when full, x-range when partial, any when `*`. */
function exactOrXRange(p: PartialVersion): Comparator[] {
  if (p.major === "*") return [];
  if (p.minor === "*") return [lowerBound(p), upperBound(p.major + 1, 0, 0)];
  if (p.patch === "*") return [lowerBound(p), upperBound(p.major, p.minor + 1, 0)];
  return [
    {
      op: "=",
      version: {
        major: p.major,
        minor: p.minor,
        patch: p.patch,
        prerelease: p.prerelease ?? [],
      },
    },
  ];
}

/** Parse one range token into zero or more comparators, or null when invalid. */
function parseToken(token: string): Comparator[] | null {
  const opMatch = /^(>=|<=|>|<|=)(.*)$/.exec(token);
  if (opMatch) {
    const op = opMatch[1];
    const operand = opMatch[2];
    // Operators require a full concrete version — `>=1.2.x` is invalid here.
    if (op === undefined || operand === undefined) return null;
    const version = parseVersion(operand);
    if (version === null) return null;
    return [{ op: op as Op, version }];
  }
  if (token === "^" || token === "~" || token === "") return null;
  const sigil = token[0] === "^" || token[0] === "~" ? token[0] : null;
  const partial = parsePartial(sigil ? token.slice(1) : token);
  if (partial === null) return null;
  if (sigil === "^") return caret(partial);
  if (sigil === "~") return tilde(partial);
  return exactOrXRange(partial);
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) - Number(b);
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function compare(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  // A release outranks any of its own prereleases.
  if (ap.length === 0) return 1;
  if (bp.length === 0) return -1;
  const shared = Math.min(ap.length, bp.length);
  for (let i = 0; i < shared; i++) {
    const ai = ap[i];
    const bi = bp[i];
    if (ai === undefined || bi === undefined) break;
    if (ai !== bi) return compareIdentifiers(ai, bi);
  }
  return ap.length - bp.length;
}

function satisfiesComparator(c: Comparator, v: SemVer): boolean {
  const cmp = compare(v, c.version);
  switch (c.op) {
    case "=":
      return cmp === 0;
    case ">":
      return cmp > 0;
    case ">=":
      return cmp >= 0;
    case "<":
      return cmp < 0;
    case "<=":
      return cmp <= 0;
  }
}

function satisfiesAlternative(alternative: string, v: SemVer): boolean {
  const trimmed = alternative.trim();
  // An empty `||` branch is a typo, not a wildcard — deny it.
  if (trimmed === "") return false;
  const comparators: Comparator[] = [];
  for (const raw of trimmed.split(/\s+/)) {
    // Tolerate a leading `v` on range tokens (`v1.2.3`, `>=v1.2.3`).
    const token = /^[vV]\d/.test(raw) ? raw.slice(1) : raw;
    const parsed = parseToken(token);
    if (parsed === null) return false;
    comparators.push(...parsed);
  }
  return comparators.every((c) => satisfiesComparator(c, v));
}

/**
 * True when `version` satisfies the semver `range`. Deny-first: any parse
 * failure in either argument returns false rather than throwing.
 */
export function satisfies(range: string, version: string): boolean {
  // Tolerate a leading `v` on the version argument too.
  const versionArg = /^[vV]\d/.test(version.trim()) ? version.trim().slice(1) : version.trim();
  const v = parseVersion(versionArg);
  if (v === null) return false;
  return range
    .trim()
    .split("||")
    .some((alternative) => satisfiesAlternative(alternative, v));
}
