// SPDX-License-Identifier: AGPL-3.0-or-later
// A hand-rolled 5-field cron parser (declared choice in HEARTBEAT.md: no
// node-cron dependency; the grammar we need is small and the semantics are
// testable). Fields: minute hour day-of-month month day-of-week, each
// accepting `*`, numbers, ranges `a-b`, steps `*/n` and `a-b/n`, and
// comma-separated lists. Vixie-cron dom/dow semantics: both restricted →
// union; exactly one restricted → intersection; neither → every day.
//
// 2.0.3: expressions are interpreted in a target IANA timezone (default
// UTC) via Intl.DateTimeFormat — Node ships full ICU. Wall times that do
// not exist (a DST spring-forward gap) are skipped, vixie-cron style;
// ambiguous wall times (fall-back) resolve to the FIRST occurrence.

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

/** Throws RangeError for unknown IANA timezone names. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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
  return dayMatchesParts(s, year, month0, day, new Date(Date.UTC(year, month0, day)).getUTCDay());
}

function dayMatchesParts(
  s: CronSchedule,
  year: number,
  month0: number,
  day: number,
  jsDay: number,
): boolean {
  if (!s.months.includes(month0 + 1)) return false;
  const domHit = s.doms.includes(day);
  const dowHit = s.dows.includes(jsDay);
  if (s.domRestricted && s.dowRestricted) return domHit || dowHit; // union
  if (s.domRestricted) return domHit;
  if (s.dowRestricted) return dowHit;
  return true;
}

const MINUTE_MS = 60_000;
/** Safety bound: give up (throw) if no fire exists within ~4 years. */
const MAX_DAY_SCAN = 366 * 4;

// ---------------------------------------------------------------------------
// Timezone-aware wall-clock arithmetic (2.0.3). Node's Intl carries full ICU;
// Intl.DateTimeFormat with `timeZone` is the only portable source of
// zone-local wall time and offsets.
// ---------------------------------------------------------------------------

interface WallParts {
  y: number;
  m0: number;
  d: number;
  h: number;
  min: number;
  s: number;
  weekday: number; // 0 = Sunday
}

const WEEKDAY_BY_NAME: ReadonlyMap<string, number> = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(tz: string): Intl.DateTimeFormat {
  let fmt = partsCache.get(tz);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    partsCache.set(tz, fmt);
  }
  return fmt;
}

/** Wall-clock components of a UTC instant, in `tz`. */
function wallParts(utcMs: number, tz: string): WallParts {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const by = new Map<string, string>();
  for (const p of parts) by.set(p.type, p.value);
  return {
    y: Number(by.get("year")),
    m0: Number(by.get("month")) - 1,
    d: Number(by.get("day")),
    h: Number(by.get("hour")),
    min: Number(by.get("minute")),
    s: Number(by.get("second")),
    weekday: WEEKDAY_BY_NAME.get(by.get("weekday") ?? "") ?? -1,
  };
}

/** The zone's offset at `utcMs` (ms east of UTC), derived from wall parts.
 * Real-zone offsets are whole minutes, so second-granularity rounding is
 * harmless; zonedWallToUtc verifies its result regardless. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const w = wallParts(utcMs, tz);
  const asUtc = Date.UTC(w.y, w.m0, w.d, w.h, w.min, w.s);
  return asUtc - utcMs;
}

/**
 * The instant of a wall time in `tz`, or null when that wall time does not
 * exist (DST spring-forward gap). Ambiguous times (fall-back) resolve to the
 * FIRST occurrence — one fire, never two.
 */
function zonedWallToUtc(
  y: number,
  m0: number,
  d: number,
  h: number,
  min: number,
  tz: string,
): number | null {
  const guess = Date.UTC(y, m0, d, h, min);
  const off1 = tzOffsetMs(guess, tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(t, tz);
  if (off2 !== off1) t = guess - off2; // refine once across a transition edge
  const w = wallParts(t, tz);
  if (w.y !== y || w.m0 !== m0 || w.d !== d || w.h !== h || w.min !== min) return null;
  return t;
}

/** Local-date arithmetic: advance a (y, m0, d) by `days`, normalized. */
function addDays(
  y: number,
  m0: number,
  d: number,
  days: number,
): { y: number; m0: number; d: number } {
  const norm = new Date(Date.UTC(y, m0, d + days));
  return { y: norm.getUTCFullYear(), m0: norm.getUTCMonth(), d: norm.getUTCDate() };
}

/**
 * The next fire time strictly after `afterMs`, in epoch ms. The expression is
 * interpreted in `timeZone` (IANA name, default "UTC"): a spec with
 * `timezone: "Asia/Karachi"` and `schedule: "0 3 * * *"` fires at 03:00 PKT,
 * not 03:00 UTC. Missed-fire detection compares instants, so it uses the
 * same zone automatically.
 */
export function nextFire(s: CronSchedule, afterMs: number, timeZone = "UTC"): number {
  if (timeZone !== "UTC") {
    if (!isValidTimeZone(timeZone)) {
      throw new RangeError(`unknown IANA timezone "${timeZone}"`);
    }
    return nextFireZoned(s, afterMs, timeZone);
  }
  const after = new Date(afterMs);
  // Start at the next minute boundary strictly after `afterMs`.
  let cursor =
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      after.getUTCHours(),
      after.getUTCMinutes(),
    ) + MINUTE_MS;

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

/** Day-scan in the target zone: candidate local wall times → instants. */
function nextFireZoned(s: CronSchedule, afterMs: number, tz: string): number {
  // Start from the local date of afterMs; candidates today with an instant
  // strictly after afterMs are eligible, later days follow.
  const start = wallParts(afterMs, tz);
  for (let dayOffset = 0; dayOffset <= MAX_DAY_SCAN; dayOffset++) {
    const date = addDays(start.y, start.m0, start.d, dayOffset);
    // Weekday in the target zone: probe local noon, which exists in every
    // real zone (DST shifts are ≤ 2h).
    const noon = zonedWallToUtc(date.y, date.m0, date.d, 12, 0, tz);
    const jsDay = noon === null ? -1 : wallParts(noon, tz).weekday;
    if (jsDay >= 0 && dayMatchesParts(s, date.y, date.m0, date.d, jsDay)) {
      for (const hour of s.hours) {
        for (const minute of s.minutes) {
          const t = zonedWallToUtc(date.y, date.m0, date.d, hour, minute, tz);
          if (t !== null && t > afterMs) return t;
        }
      }
    }
  }
  throw new Error("cron schedule never fires within 4 years — refusing to spin forever");
}
