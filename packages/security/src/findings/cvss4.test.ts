// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { scoreCvss4, Cvss4Vector, Cvss4Error } from "./cvss4.js";

// Published vectors from the FIRST CVSS v4.0 Examples document
// (https://www.first.org/cvss/v4.0/examples), each an independently
// published score. The port must reproduce them exactly.
const VECTORS: Array<[string, number]> = [
  ["CVSS:4.0/AV:L/AC:L/AT:P/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", 7.3],
  ["CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N", 7.7],
  ["CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N/E:U", 5.2],
  ["CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:L/VA:L/SC:N/SI:N/SA:N", 8.3],
  [
    "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:L/VA:L/SC:N/SI:N/SA:N/CR:H/IR:L/AR:L/MAV:N/MAC:H/MVC:H/MVI:L/MVA:L",
    8.1,
  ],
  ["CVSS:4.0/AV:L/AC:L/AT:N/PR:N/UI:A/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N", 4.6],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:N/VA:N/SC:L/SI:L/SA:N", 5.1],
  ["CVSS:4.0/AV:L/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 9.4],
  ["CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H", 10.0],
  // R2-1 regression: eq3=1/eq6=1 macrovector (111201) with a lowered CR —
  // the eq3/eq6 next-lower transition must be 11→21 (eq3 INCREMENTED), not
  // an identity. Reference score: 4.8.
  ["CVSS:4.0/AV:N/AC:H/AT:N/PR:L/UI:P/VC:H/VI:L/VA:L/SC:L/SI:N/SA:N/CR:L", 4.8],
];

describe("CVSS 4.0 base scoring", () => {
  for (const [vector, expected] of VECTORS) {
    it(`${vector.slice(0, 72)}${vector.length > 72 ? "…" : ""} = ${expected}`, () => {
      expect(scoreCvss4(vector)).toBe(expected);
    });
  }

  it("a no-impact vector scores 0", () => {
    expect(scoreCvss4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:N/VI:N/VA:N/SC:N/SI:N/SA:N")).toBe(0);
  });

  it("threat metrics move the score (E:U lowers the same base vector)", () => {
    const base = "CVSS:4.0/AV:N/AC:L/AT:P/PR:N/UI:P/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N";
    expect(scoreCvss4(`${base}/E:U`)).toBeLessThan(scoreCvss4(base));
  });

  it("malformed vectors are refused with structured errors", () => {
    expect(() => scoreCvss4("CVSS:3.1/AV:N")).toThrow(Cvss4Error);
    expect(() => scoreCvss4("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H")).toThrow(
      /missing mandatory base metric SC/,
    );
    expect(() =>
      scoreCvss4("CVSS:4.0/AV:Q/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"),
    ).toThrow(/invalid value "Q"/);
    expect(() =>
      scoreCvss4("CVSS:4.0/AV:N/AV:N/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"),
    ).toThrow(/duplicated metric/);
  });

  it("equivalentClasses computes the macrovector digits", () => {
    const v = new Cvss4Vector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H");
    // eq4 is 1 (SC:H subsequent impact; only MSI:S/MSA:S give 0) and eq6 is 0
    // (CR/IR/AR default H, meeting the H vulnerable-system impacts).
    expect(v.equivalentClasses()).toBe("000100");
  });
});
