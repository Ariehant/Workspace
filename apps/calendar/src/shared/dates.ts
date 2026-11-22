/**
 * Dates as Workspace has them: wall-clock times with no time zone.
 *
 * The API writes a stored time as `2026-11-24T10:00:00.000+00:00`, but the `+00:00` isn't
 * real UTC: it's the time as the user typed it. So the calendar works in wall-clock strings
 * (`YYYY-MM-DD` for days, `YYYY-MM-DDTHH:mm` for times) and never converts them; only "now"
 * comes from the system clock, in the system's zone. Writes send times with no zone, which the
 * server stores exactly as written (a `Z` or an offset would make it convert to UTC).
 *
 * The arithmetic below uses `Date.UTC` only as a calendar: no zone, no daylight saving.
 */

/** `YYYY-MM-DD` */
export type Day = string;
/** `YYYY-MM-DDTHH:mm` */
export type WallTime = string;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export const isDay = (s: string): boolean => DAY.test(s);

/** Milliseconds on a zone-less timeline (for arithmetic only). */
function ms(value: Day | WallTime): number {
  const t = TIME.exec(value);
  if (t) return Date.UTC(+t[1]!, +t[2]! - 1, +t[3]!, +t[4]!, +t[5]!);
  const d = DAY.exec(value);
  if (d) return Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!);
  throw new Error(`Not a date: ${value}`);
}

function fromMs(t: number): WallTime {
  const d = new Date(t);
  return `${dayFromMs(t)}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function dayFromMs(t: number): Day {
  const d = new Date(t);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const addMinutes = (time: WallTime, minutes: number): WallTime =>
  fromMs(ms(time) + minutes * MINUTE_MS);

export const addDays = (day: Day, days: number): Day => dayFromMs(ms(day) + days * DAY_MS);

/** Whole months, keeping the day of the month where it exists (else the month's last day). */
export function addMonths(day: Day, months: number): Day {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return dayFromMs(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last)));
}

/** Minutes from `a` to `b`. */
export const diffMinutes = (a: WallTime, b: WallTime): number =>
  Math.round((ms(b) - ms(a)) / MINUTE_MS);

/** Days from `a` to `b`. */
export const diffDays = (a: Day, b: Day): number => Math.round((ms(b) - ms(a)) / DAY_MS);

export const dayOf = (time: WallTime | Day): Day => time.slice(0, 10);

/** Minutes since midnight. */
export const minutesOf = (time: WallTime): number => {
  const t = TIME.exec(time);
  return t ? +t[4]! * 60 + +t[5]! : 0;
};

export const atMinutes = (day: Day, minutes: number): WallTime =>
  addMinutes(`${day}T00:00`, minutes);

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (day: Day): number => new Date(ms(day)).getUTCDay();

/** The first day of `day`'s week (weeks starting on `weekStartsOn`, 0 = Sunday). */
export const startOfWeek = (day: Day, weekStartsOn = 1): Day =>
  addDays(day, -((weekday(day) - weekStartsOn + 7) % 7));

export const startOfMonth = (day: Day): Day => `${day.slice(0, 7)}-01`;

/** The system clock as a wall-clock time in the system's time zone. */
export function nowWall(now: Date = new Date()): WallTime {
  return `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}`;
}

export const today = (now: Date = new Date()): Day => dayOf(nowWall(now));

/**
 * When a wall-clock time happens on this machine (for notifications). In a daylight-saving gap
 * the result is the next real instant.
 */
export function instantOf(time: WallTime | Day): Date {
  const [y, m, d] = time.slice(0, 10).split('-').map(Number) as [number, number, number];
  const minutes = time.length > 10 ? minutesOf(time) : 0;
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
}

// --- The API's date values -------------------------------------------------------------

/** A date property's value as the API returns it. */
export interface ApiDate {
  start: string;
  end: string | null;
  time_zone?: string | null;
}

/** An event's time, read from a date value. */
export interface EventTime {
  allDay: boolean;
  /** All-day: `YYYY-MM-DD`. Timed: `YYYY-MM-DDTHH:mm`. */
  start: string;
  /** All-day: the last day (inclusive). Timed: the end (exclusive). */
  end: string;
  /** The source has an end. A timed value without one shows as an hour. */
  endSet: boolean;
}

/** The length shown for a timed row with no end. */
export const DEFAULT_DURATION_MINUTES = 60;

const VALID_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Read a date value. Takes the digits as written: `2026-11-24T10:00:00.000+00:00` is 10:00 on
 * the wall clock, wherever the user is. `null` for an empty or unreadable value.
 */
export function readApiDate(value: ApiDate | null | undefined): EventTime | null {
  if (!value || typeof value.start !== 'string') return null;
  const end = typeof value.end === 'string' ? value.end : null;
  if (isDay(value.start)) {
    // A range ending on a time (rare): its day is the last day.
    const last = end && (isDay(end) || VALID_TIME.test(end)) ? end.slice(0, 10) : null;
    return {
      allDay: true,
      start: value.start,
      end: last && last > value.start ? last : value.start,
      endSet: !!last && last > value.start,
    };
  }
  if (!VALID_TIME.test(value.start)) return null;
  const start = value.start.slice(0, 16);
  // An end given as a day (rare) ends at the start of that day.
  const endTime =
    end && VALID_TIME.test(end) ? end.slice(0, 16) : end && isDay(end) ? `${end}T00:00` : null;
  if (endTime && endTime > start) return { allDay: false, start, end: endTime, endSet: true };
  return { allDay: false, start, end: addMinutes(start, DEFAULT_DURATION_MINUTES), endSet: false };
}

/**
 * A date value to send: times with no zone (stored as written), days as days. A timed event's
 * end is only written if the source had one or the user set one (`endSet`).
 */
export function writeApiDate(time: EventTime): { start: string; end: string | null } {
  if (time.allDay) {
    const start = time.start.slice(0, 10);
    const end = time.end.slice(0, 10);
    return { start, end: end > start ? end : null };
  }
  return { start: time.start.slice(0, 16), end: time.endSet ? time.end.slice(0, 16) : null };
}

/**
 * The range the calendar keeps: 6 months back to 12 ahead (as day bounds, which the API
 * compares as days).
 */
export function syncWindow(now: Date = new Date()): { from: Day; to: Day } {
  const d = today(now);
  return { from: addMonths(d, -6), to: addMonths(d, 12) };
}
