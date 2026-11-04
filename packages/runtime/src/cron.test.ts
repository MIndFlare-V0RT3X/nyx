// SPDX-License-Identifier: AGPL-3.0-or-later
// Cron parser unit tests: grammar, ranges/steps/lists, vixie dom/dow
// semantics, and nextFire correctness against fixed instants (UTC).
import { describe, expect, it } from "vitest";
import { nextFire, parseCron } from "./cron.js";

// 2026-03-15T10:07:30Z (a Sunday)
const T0 = Date.UTC(2026, 2, 15, 10, 7, 30);

describe("parseCron", () => {
  it("parses the full grammar: *, numbers, ranges, steps, lists", () => {
    const s = parseCron("*/15 2-4 1,15 */2 1-5");
    expect(s.minutes).toEqual([0, 15, 30, 45]);
    expect(s.hours).toEqual([2, 3, 4]);
    expect(s.doms).toEqual([1, 15]);
    expect(s.months).toEqual([1, 3, 5, 7, 9, 11]); // */2 steps from the range min
    expect(s.dows).toEqual([1, 2, 3, 4, 5]);
    expect(s.domRestricted).toBe(true);
    expect(s.dowRestricted).toBe(true);
  });

  it("rejects malformed expressions", () => {
    expect(() => parseCron("* * * *")).toThrow(/5 fields/);
    expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("* 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("a * * * *")).toThrow(/invalid/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/invalid step/);
  });
});

describe("nextFire", () => {
  it("daily at 03:00 fires tomorrow at 03:00 when today's has passed", () => {
    const s = parseCron("0 3 * * *");
    expect(nextFire(s, T0)).toBe(Date.UTC(2026, 2, 16, 3, 0));
  });

  it("hourly at :30 fires at the next half hour", () => {
    const s = parseCron("30 * * * *");
    expect(nextFire(s, T0)).toBe(Date.UTC(2026, 2, 15, 10, 30));
  });

  it("every 15 minutes rounds up strictly after the cursor", () => {
    const s = parseCron("*/15 * * * *");
    expect(nextFire(s, T0)).toBe(Date.UTC(2026, 2, 15, 10, 15));
    expect(nextFire(s, Date.UTC(2026, 2, 15, 10, 15))).toBe(Date.UTC(2026, 2, 15, 10, 30));
  });

  it("a specific month/day skips a year when passed", () => {
    const s = parseCron("0 0 1 1 *"); // Jan 1 00:00
    expect(nextFire(s, Date.UTC(2026, 2, 15))).toBe(Date.UTC(2027, 0, 1, 0, 0));
  });

  it("vixie dom/dow: both restricted → union (the 13th OR a Friday)", () => {
    // 2026-03-13 is a Friday; the 16th is a Monday; the 20th is a Friday.
    const s = parseCron("0 9 13 * 5");
    // From the 12th: the 13th (dom hit) comes first.
    expect(nextFire(s, Date.UTC(2026, 2, 12))).toBe(Date.UTC(2026, 2, 13, 9, 0));
    // From the 14th: the next dom hit is next month's 13th, but the 20th
    // (dow hit) is sooner — the union takes it.
    expect(nextFire(s, Date.UTC(2026, 2, 14))).toBe(Date.UTC(2026, 2, 20, 9, 0));
  });

  it("vixie dom/dow: only dow restricted → intersection with dom *", () => {
    const s = parseCron("0 9 * * 1"); // Mondays
    expect(nextFire(s, T0)).toBe(Date.UTC(2026, 2, 16, 9, 0)); // the 16th is a Monday
  });
});
