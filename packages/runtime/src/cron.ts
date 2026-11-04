// SPDX-License-Identifier: AGPL-3.0-or-later
// A hand-rolled 5-field cron parser (declared choice in HEARTBEAT.md: no
// node-cron dependency; the grammar we need is small and the semantics are
// testable). Fields: minute hour day-of-month month day-of-week, each
// accepting `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, and
// comma-separated lists. Vixie-cron dom/dow semantics: both restricted →
// union; exactly one restricted → intersection; neither → every day.

export interface CronSchedule {
  minutes: number[];
  hours: number[];
  doms: number[];
  months: number[];
  dows: number[];
  /** True when the dom field is not `*`. */
  domRestricted: boolean;
  /** True when the dow field is not `*`. */
  dowRestricted: boolean;
}

const FIELD_BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

function parseField(field: string, idx: number): { values: number[]; restricted: boolean } {
  const [min, max] = FIELD_BOUNDS[idx]!;
  const restricted = field !== "*";
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const stepMatch = /^(.+?)(?:\/(\d+))?$/.exec(part);
    if (stepMatch === null) throw new Error(`invalid cron field "${field}"`);
    const rangePart = stepMatch[1]!;
    const step = stepMatch[2] !== undefined ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step in cron field "${field}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const range = /^(\d+)-(\d+)$/.exec(rangePart);
      if (range !== null) {
        lo = Number(range[1]);
        hi = Number(range[2]);
      } else if (/^\d+$/.test(rangePart)) {
        lo = Number(rangePart);
        hi = stepMatch[2] !== undefined ? max : lo;
      } else {
        throw new Error(`invalid cron field "${field}"`);
      }
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field "${field}" out of range [${min}-${max}]`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  const list = [...values].sort((a, b) => a - b);
  if (list.length === 0) throw new Error(`empty cron field "${field}"`);
  return { values: list, restricted };
}

/** Parse a 5-field cron expression. Throws on anything else. */
export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron expression must have 5 fields, got ${fields.length}: "${expr}"`);
  }
  const parsed = fields.map((f, i) => parseField(f, i));
  const minute = parsed[0]!;
  const hour = parsed[1]!;
  const dom = parsed[2]!;
  const month = parsed[3]!;
  const dow = parsed[4]!;
  return {
    minutes: minute.values,
    hours: hour.values,
    doms: dom.values,
    months: month.values,
    dows: dow.values,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
  };
}

function dayMatches(s: CronSchedule, year: number, month0: number, day: number): boolean {
  if (!s.months.includes(month0 + 1)) return false;
  const domHit = s.doms.includes(day);
  const jsDay = new Date(Date.UTC(year, month0, day)).getUTCDay();
  const dowHit = s.dows.includes(jsDay);
  if (s.domRestricted && s.dowRestricted) return domHit || dowHit; // union
  if (s.domRestricted) return domHit;
  if (s.dowRestricted) return dowHit;
  return true;
}

const MINUTE_MS = 60_000;
/** Safety bound: give up (throw) if no fire exists within ~4 years. */
const MAX_DAY_SCAN = 366 * 4;

/**
 * The next fire time strictly after `afterMs`, in epoch ms. Uses UTC so
 * schedules are stable across the host's local timezone changes (a personal
 * harness runs on one machine; DST transitions are the operator's problem to
 * schedule around, and UTC keeps the guarantee testable).
 */
export function nextFire(s: CronSchedule, afterMs: number): number {
  const after = new Date(afterMs);
  // Start at the next minute boundary strictly after `afterMs`.
  let cursor = Date.UTC(after.getUTCFullYear(), after.getUTCMonth(), after.getUTCDate(), after.getUTCHours(), after.getUTCMinutes()) + MINUTE_MS;

  for (let dayOffset = 0; dayOffset <= MAX_DAY_SCAN; dayOffset++) {
    const probe = new Date(cursor);
    const year = probe.getUTCFullYear();
    const month0 = probe.getUTCMonth();
    const day = probe.getUTCDate();
    const dayStart = Date.UTC(year, month0, day);
    if (!dayMatches(s, year, month0, day)) {
      // Jump to the next day's first candidate minute.
      cursor = dayStart + 86_400_000;
      continue;
    }
    // Find the first (hour, minute) of this day that is >= cursor.
    for (const hour of s.hours) {
      for (const minute of s.minutes) {
        const t = dayStart + hour * 3_600_000 + minute * MINUTE_MS;
        if (t >= cursor) return t;
      }
    }
    // All of today's candidates passed already — next matching day.
    cursor = dayStart + 86_400_000;
  }
  throw new Error("cron schedule never fires within 4 years — refusing to spin forever");
}
