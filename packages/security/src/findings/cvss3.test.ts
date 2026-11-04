// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { scoreCvss3Vector, scoreCvss3, parseCvss3, Cvss3Error } from "./cvss3.js";

// Published vectors: canonical NVD/FIRST 3.1 examples (Log4Shell 10.0,
// Heartbleed 7.5, the standard reflected-XSS 6.1, the standard
// unauthenticated RCE 9.8) plus four independently formula-verified vectors
// from published scoring references.
const VECTORS: Array<[string, number]> = [
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10.0],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N", 9.1],
  ["CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:L/I:L/A:N", 5.4],
  ["CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:N/I:L/A:N", 3.1],
  // The canonical "network, low privileges, no interaction, full CIA"
  // vector — published on thousands of NVD entries.
  ["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H", 8.8],
];

describe("CVSS 3.1 base scoring", () => {
  for (const [vector, expected] of VECTORS) {
    it(`${vector} = ${expected}`, () => {
      expect(scoreCvss3Vector(vector)).toBe(expected);
    });
  }

  it("a no-impact vector scores 0", () => {
    expect(
      scoreCvss3Vector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N"),
    ).toBe(0);
  });

  it("the scope-dependent PR weights are applied (the 9.0 vs 8.x family)", () => {
    // Same vector with PR:L under S:U instead of S:C scores a step lower —
    // PR:L is 0.62 (U) vs 0.68 (C).
    const m = parseCvss3("CVSS:3.1/AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:H/A:L");
    expect(scoreCvss3({ ...m, S: "U" })).toBeLessThan(scoreCvss3(m));
  });

  it("malformed vectors are refused with structured errors", () => {
    expect(() => scoreCvss3Vector("CVSS:3.0/AV:N/AC:L")).toThrow(Cvss3Error);
    expect(() => scoreCvss3Vector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H")).toThrow(
      /missing mandatory base metric A/,
    );
    expect(() => scoreCvss3Vector("CVSS:3.1/AV:Q/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toThrow(
      /invalid value "Q"/,
    );
    expect(() => scoreCvss3Vector("CVSS:3.1/AV:N/AV:N/PR:N/UI:N/S:U/C:H/I:H/A:H")).toThrow(
      /duplicated metric/,
    );
  });
});
