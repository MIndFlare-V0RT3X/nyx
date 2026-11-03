// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { satisfies } from "./semver.js";

describe("satisfies: any (*)", () => {
  it("matches any valid version", () => {
    expect(satisfies("*", "0.0.0")).toBe(true);
    expect(satisfies("*", "0.1.0")).toBe(true);
    expect(satisfies("*", "99.99.99")).toBe(true);
    expect(satisfies("*", "1.2.3-rc.1")).toBe(true);
  });

  it("never matches an invalid version", () => {
    expect(satisfies("*", "banana")).toBe(false);
    expect(satisfies("*", "1.2")).toBe(false);
    expect(satisfies("*", "1.2.3.4")).toBe(false);
    expect(satisfies("*", "")).toBe(false);
  });
});

describe("satisfies: exact", () => {
  it("matches only that version", () => {
    expect(satisfies("0.1.0", "0.1.0")).toBe(true);
    expect(satisfies("0.1.0", "0.1.1")).toBe(false);
    expect(satisfies("0.1.0", "0.2.0")).toBe(false);
    expect(satisfies("0.1.0", "1.1.0")).toBe(false);
  });

  it("supports = and a leading v", () => {
    expect(satisfies("=1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("=1.2.3", "1.2.4")).toBe(false);
    expect(satisfies("v1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "v1.2.3")).toBe(true);
  });

  it("ignores build metadata on both sides", () => {
    expect(satisfies("1.2.3+build.7", "1.2.3")).toBe(true);
    expect(satisfies("1.2.3", "1.2.3+build.7")).toBe(true);
  });

  it("does not match a prerelease of the exact version", () => {
    expect(satisfies("0.1.0", "0.1.0-rc.1")).toBe(false);
    expect(satisfies("0.1.0-rc.1", "0.1.0")).toBe(false);
    expect(satisfies("0.1.0-rc.1", "0.1.0-rc.1")).toBe(true);
  });
});

describe("satisfies: caret ^", () => {
  it("allows minor+patch within a stable major", () => {
    expect(satisfies("^1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("^1.2.3", "1.2.4")).toBe(true);
    expect(satisfies("^1.2.3", "1.9.9")).toBe(true);
    expect(satisfies("^1.2.3", "2.0.0")).toBe(false);
    expect(satisfies("^1.2.3", "1.2.2")).toBe(false);
  });

  it("locks the minor when major is 0", () => {
    expect(satisfies("^0.2.3", "0.2.3")).toBe(true);
    expect(satisfies("^0.2.3", "0.2.9")).toBe(true);
    expect(satisfies("^0.2.3", "0.3.0")).toBe(false);
    expect(satisfies("^0.2.3", "0.2.2")).toBe(false);
  });

  it("locks the patch when major and minor are 0", () => {
    expect(satisfies("^0.0.3", "0.0.3")).toBe(true);
    expect(satisfies("^0.0.3", "0.0.4")).toBe(false);
    expect(satisfies("^0.0.3", "0.0.2")).toBe(false);
  });

  it("supports partials with 0.x semantics", () => {
    expect(satisfies("^0.1", "0.1.0")).toBe(true);
    expect(satisfies("^0.1", "0.1.9")).toBe(true);
    expect(satisfies("^0.1", "0.2.0")).toBe(false);
    expect(satisfies("^0.0", "0.0.9")).toBe(true);
    expect(satisfies("^0.0", "0.1.0")).toBe(false);
    expect(satisfies("^1", "1.0.0")).toBe(true);
    expect(satisfies("^1", "1.9.9")).toBe(true);
    expect(satisfies("^1", "2.0.0")).toBe(false);
    expect(satisfies("^0", "0.9.9")).toBe(true);
    expect(satisfies("^0", "1.0.0")).toBe(false);
  });

  it("includes declared lower-bound prereleases", () => {
    expect(satisfies("^0.1.0-rc.1", "0.1.0-rc.1")).toBe(true);
    expect(satisfies("^0.1.0-rc.1", "0.1.0-rc.2")).toBe(true);
    expect(satisfies("^0.1.0-rc.1", "0.1.0")).toBe(true);
    expect(satisfies("^0.1.0-rc.1", "0.1.0-rc.0")).toBe(false);
  });
});

describe("satisfies: tilde ~", () => {
  it("allows patch within the minor", () => {
    expect(satisfies("~1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("~1.2.3", "1.2.9")).toBe(true);
    expect(satisfies("~1.2.3", "1.3.0")).toBe(false);
    expect(satisfies("~1.2.3", "1.2.2")).toBe(false);
  });

  it("treats a missing patch as .0", () => {
    expect(satisfies("~1.2", "1.2.0")).toBe(true);
    expect(satisfies("~1.2", "1.2.9")).toBe(true);
    expect(satisfies("~1.2", "1.3.0")).toBe(false);
  });

  it("allows minor within the major when only major given", () => {
    expect(satisfies("~1", "1.0.0")).toBe(true);
    expect(satisfies("~1", "1.9.9")).toBe(true);
    expect(satisfies("~1", "2.0.0")).toBe(false);
  });
});

describe("satisfies: comparators", () => {
  it(">=", () => {
    expect(satisfies(">=1.2.3", "1.2.3")).toBe(true);
    expect(satisfies(">=1.2.3", "1.2.4")).toBe(true);
    expect(satisfies(">=1.2.3", "1.2.2")).toBe(false);
    expect(satisfies(">=0.1.0", "0.1.0")).toBe(true);
  });

  it(">", () => {
    expect(satisfies(">1.2.3", "1.2.3")).toBe(false);
    expect(satisfies(">1.2.3", "1.2.4")).toBe(true);
    expect(satisfies(">1.2.3", "1.2.2")).toBe(false);
  });

  it("<=", () => {
    expect(satisfies("<=1.2.3", "1.2.3")).toBe(true);
    expect(satisfies("<=1.2.3", "1.2.4")).toBe(false);
    expect(satisfies("<=1.2.3", "1.2.2")).toBe(true);
  });

  it("<", () => {
    expect(satisfies("<1.2.3", "1.2.3")).toBe(false);
    expect(satisfies("<1.2.3", "1.2.2")).toBe(true);
    expect(satisfies("<2.0.0", "1.9.9")).toBe(true);
  });
});

describe("satisfies: x-ranges (bare partials)", () => {
  it("1.x / 1 / 1.* stay within the major", () => {
    expect(satisfies("1.x", "1.0.0")).toBe(true);
    expect(satisfies("1.x", "1.9.9")).toBe(true);
    expect(satisfies("1.x", "2.0.0")).toBe(false);
    expect(satisfies("1", "1.5.0")).toBe(true);
    expect(satisfies("1.*", "1.5.0")).toBe(true);
    expect(satisfies("1", "0.9.9")).toBe(false);
  });

  it("1.2.x / 1.2 stay within the minor", () => {
    expect(satisfies("1.2.x", "1.2.0")).toBe(true);
    expect(satisfies("1.2.x", "1.2.9")).toBe(true);
    expect(satisfies("1.2.x", "1.3.0")).toBe(false);
    expect(satisfies("1.2", "1.2.9")).toBe(true);
    expect(satisfies("0.1.x", "0.1.0")).toBe(true);
    expect(satisfies("0.1.x", "0.2.0")).toBe(false);
  });

  it("excludes prereleases of the upper boundary", () => {
    expect(satisfies("1.2.x", "1.3.0-alpha")).toBe(false);
    expect(satisfies("^1.2.3", "2.0.0-rc.1")).toBe(false);
    expect(satisfies("~1.2.3", "1.3.0-alpha")).toBe(false);
  });
});

describe("satisfies: AND / OR combinations", () => {
  it("space-separated comparators AND together", () => {
    expect(satisfies(">=1.2.3 <2.0.0", "1.2.3")).toBe(true);
    expect(satisfies(">=1.2.3 <2.0.0", "1.9.9")).toBe(true);
    expect(satisfies(">=1.2.3 <2.0.0", "2.0.0")).toBe(false);
    expect(satisfies(">=1.2.3 <2.0.0", "1.2.2")).toBe(false);
  });

  it("|| alternatives OR together", () => {
    expect(satisfies("^1.0.0 || ^2.0.0", "1.5.0")).toBe(true);
    expect(satisfies("^1.0.0 || ^2.0.0", "2.5.0")).toBe(true);
    expect(satisfies("^1.0.0 || ^2.0.0", "3.0.0")).toBe(false);
    expect(satisfies("^1.0.0 || ^2.0.0", "0.9.0")).toBe(false);
  });

  it("combines AND and OR with mixed forms", () => {
    expect(satisfies(">=1.0.0 <2.0.0 || ^3.0.0", "1.5.0")).toBe(true);
    expect(satisfies(">=1.0.0 <2.0.0 || ^3.0.0", "3.4.5")).toBe(true);
    expect(satisfies(">=1.0.0 <2.0.0 || ^3.0.0", "2.5.0")).toBe(false);
    expect(satisfies("~0.1.0 || 0.1.x", "0.1.5")).toBe(true);
  });

  it("tolerates surrounding whitespace", () => {
    expect(satisfies("  >=1.0.0   <2.0.0  ", "1.5.0")).toBe(true);
    expect(satisfies(" ^1.0.0 || ^2.0.0 ", "2.1.0")).toBe(true);
  });
});

describe("satisfies: prerelease ordering", () => {
  it("a release outranks its prereleases", () => {
    expect(satisfies(">=0.1.0", "0.1.0-rc.1")).toBe(false);
    expect(satisfies(">=0.1.0-rc.1", "0.1.0")).toBe(true);
    expect(satisfies("<0.2.0", "0.2.0-rc.1")).toBe(true);
  });

  it("numeric identifiers sort below alphanumeric ones", () => {
    expect(satisfies(">=1.2.3-2", "1.2.3-10")).toBe(true);
    expect(satisfies(">=1.2.3-alpha", "1.2.3-1")).toBe(false);
    expect(satisfies(">=1.2.3-1", "1.2.3-alpha")).toBe(true);
  });

  it("more identifiers win when prefixes are equal", () => {
    expect(satisfies(">=1.2.3-alpha", "1.2.3-alpha.1")).toBe(true);
    expect(satisfies(">=1.2.3-alpha.1", "1.2.3-alpha")).toBe(false);
  });
});

describe("satisfies: deny-first on malformed input", () => {
  it("rejects garbage ranges", () => {
    expect(satisfies("banana", "1.2.3")).toBe(false);
    expect(satisfies("^banana", "1.2.3")).toBe(false);
    expect(satisfies(">=", "1.2.3")).toBe(false);
    expect(satisfies("^", "1.2.3")).toBe(false);
    expect(satisfies("", "1.2.3")).toBe(false);
    expect(satisfies("   ", "1.2.3")).toBe(false);
  });

  it("rejects empty || alternatives instead of treating them as *", () => {
    expect(satisfies("||", "1.2.3")).toBe(false);
    expect(satisfies("1.2.3 ||", "9.9.9")).toBe(false);
    expect(satisfies("|| 1.2.3", "9.9.9")).toBe(false);
    expect(satisfies("1.2.3 || ", "9.9.9")).toBe(false);
  });

  it("still matches a valid branch next to an empty one", () => {
    expect(satisfies("1.2.3 ||", "1.2.3")).toBe(true);
    expect(satisfies("|| 1.2.3", "1.2.3")).toBe(true);
  });

  it("rejects invalid version syntax anywhere", () => {
    expect(satisfies("01.2.3", "1.2.3")).toBe(false);
    expect(satisfies("1.02.3", "1.2.3")).toBe(false);
    expect(satisfies("1.2.3-01", "1.2.3")).toBe(false);
    expect(satisfies(">=1.2.3", "1.2.3.4")).toBe(false);
    expect(satisfies(">=1.2.3", "1.2")).toBe(false);
    expect(satisfies("1.2.3", "1.2.3.4")).toBe(false);
  });

  it("rejects unsupported forms", () => {
    expect(satisfies(">= 1.2.3", "1.5.0")).toBe(false); // space after operator
    expect(satisfies(">=1.2.x", "1.5.0")).toBe(false); // wildcard with operator
    expect(satisfies("1.2.3 - 2.0.0", "1.5.0")).toBe(false); // hyphen range
    expect(satisfies("1.x.3", "1.0.3")).toBe(false); // non-trailing wildcard
  });
});
