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

describe("nextFire with timezone (2.0.3)", () => {
  it("Asia/Karachi: 03:00 PKT is 22:00 UTC the previous day, not 03:00 UTC", () => {
    const s = parseCron("0 3 * * *");
    // 2026-11-04 10:00 UTC → next 03:00 PKT is 2026-11-04 22:00 UTC (Nov 5 local).
    const t = nextFire(s, Date.UTC(2026, 10, 4, 10, 0), "Asia/Karachi");
    expect(t).toBe(Date.UTC(2026, 10, 4, 22, 0));
    // And explicitly NOT the naive UTC reading (2026-11-05 03:00 UTC).
    expect(t).not.toBe(Date.UTC(2026, 10, 5, 3, 0));
    // The local wall time really is 03:00 Karachi on Nov 5.
    expect(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Karachi",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(t)),
    ).toBe("05/11/2026, 03:00");
  });

  it("America/New_York across spring forward: one fire per day, no skip, no double", () => {
    const s = parseCron("0 3 * * *");
    // US DST 2026: spring forward Sun 2026-03-08 02:00 EST → 03:00 EDT.
    // 03:00 local exists every day: EST days map to 08:00 UTC, EDT days to 07:00 UTC.
    let cursor = Date.UTC(2026, 2, 6, 12, 0); // Mar 6 noon UTC
    const fires: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = nextFire(s, cursor, "America/New_York");
      fires.push(t);
      cursor = t;
    }
    expect(fires).toEqual([
      Date.UTC(2026, 2, 7, 8, 0), // Mar 7 03:00 EST
      Date.UTC(2026, 2, 8, 7, 0), // Mar 8 03:00 EDT (first hour after the jump)
      Date.UTC(2026, 2, 9, 7, 0), // Mar 9 03:00 EDT
      Date.UTC(2026, 2, 10, 7, 0),
      Date.UTC(2026, 2, 11, 7, 0),
    ]);
    // Strictly increasing, exactly one fire per local day: no double, no skip.
    for (let i = 1; i < fires.length; i++) expect(fires[i]!).toBeGreaterThan(fires[i - 1]!);
  });

  it("a wall time inside the spring-forward gap is skipped (vixie-cron semantics)", () => {
    // 02:30 does not exist on 2026-03-08 in New York (02:00 jumps to 03:00).
    const s = parseCron("30 2 * * *");
    const t = nextFire(s, Date.UTC(2026, 2, 7, 12, 0), "America/New_York");
    // Mar 7's 02:30 EST (07:30 UTC) already passed the cursor (Mar 7 12:00
    // UTC); Mar 8's 02:30 does not exist → Mar 9's 02:30 EDT = 06:30 UTC.
    expect(t).toBe(Date.UTC(2026, 2, 9, 6, 30));
  });

  it("fall-back ambiguity fires the wall time ONCE (first occurrence), not twice", () => {
    // US DST 2026: fall back Sun 2026-11-01 02:00 EDT → 01:00 EST, so local
    // 01:00 occurs twice. A 01:00 spec fires once, at the earlier instant;
    // the next fire is the next day's 01:00 (documented single-fire policy —
    // a personal harness does not double-run heartbeats).
    const s = parseCron("0 1 * * *");
    const t = nextFire(s, Date.UTC(2026, 10, 1, 2, 0), "America/New_York");
    expect(t).toBe(Date.UTC(2026, 10, 1, 5, 0)); // 01:00 EDT (the first 01:00)
    const next = nextFire(s, t, "America/New_York");
    expect(next).toBe(Date.UTC(2026, 10, 2, 6, 0)); // Nov 2 01:00 EST — not the repeated 01:00
  });

  it("default UTC behavior is unchanged", () => {
    const s = parseCron("0 3 * * *");
    expect(nextFire(s, Date.UTC(2026, 2, 15, 10, 0))).toBe(Date.UTC(2026, 2, 16, 3, 0));
    expect(nextFire(s, Date.UTC(2026, 2, 15, 10, 0), "UTC")).toBe(Date.UTC(2026, 2, 16, 3, 0));
  });

  it("rejects unknown timezone names", () => {
    const s = parseCron("0 3 * * *");
    expect(() => nextFire(s, Date.now(), "Mars/Olympus")).toThrow(RangeError);
  });
});
