import { dateFromString } from './format';
import { cellValue, isDateValue } from './properties';
import type { DateValue, Property, Row } from './schema';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Days since 1970-01-01 of a local date (whole days, unaffected by DST). */
export function dayIndex(date: Date): number {
  return Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

/** The local date (midnight) of a day index. */
export function dateOfDay(day: number): Date {
  const utc = new Date(day * DAY_MS);
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
}

/** `YYYY-MM-DD` of a day index. */
export function isoOfDay(day: number): string {
  const d = dateOfDay(day);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Weekday (0 = Sunday) of a day index. */
export const weekdayOf = (day: number) => dateOfDay(day).getDay();

/** The days a row covers (inclusive), from a date property (or created/edited time). */
export function rowDays(row: Row, property: Property): { start: number; end: number } | null {
  const value = cellValue(row, property);
  if (typeof value === 'number') {
    const day = dayIndex(new Date(value));
    return { start: day, end: day };
  }
  if (!isDateValue(value)) return null;
  const start = dayIndex(dateFromString(value.start));
  const end = value.end ? dayIndex(dateFromString(value.end)) : start;
  return { start, end: Math.max(start, end) };
}

/**
 * The weeks a calendar shows: the weeks covering `anchor`'s month (month mode) or
 * the week containing it, each as 7 day indices.
 */
export function calendarWeeks(anchor: Date, mode: 'month' | 'week', weekStart: 0 | 1): number[][] {
  const startOfWeek = (day: number) => day - ((weekdayOf(day) - weekStart + 7) % 7);
  let first: number;
  let last: number;
  if (mode === 'week') {
    first = startOfWeek(dayIndex(anchor));
    last = first + 6;
  } else {
    first = startOfWeek(dayIndex(new Date(anchor.getFullYear(), anchor.getMonth(), 1)));
    const monthEnd = dayIndex(new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0));
    last = startOfWeek(monthEnd) + 6;
  }
  const weeks: number[][] = [];
  for (let day = first; day <= last; day += 7) {
    weeks.push(Array.from({ length: 7 }, (_, i) => day + i));
  }
  return weeks;
}

export interface WeekBar {
  row: Row;
  /** Columns (0–6) the bar covers in this week. */
  startCol: number;
  endCol: number;
  /** Stacking line inside the week (0 = top). */
  lane: number;
  /** The range starts before / ends after this week. */
  continuesBefore: boolean;
  continuesAfter: boolean;
}

/**
 * Place a week's rows as bars: longer ranges first, each in the first lane where it
 * doesn't overlap another bar (like Notion's and most calendars' month grids).
 */
export function layoutWeek(
  rows: readonly { row: Row; start: number; end: number }[],
  weekFirstDay: number,
): { bars: WeekBar[]; lanes: number } {
  const weekLast = weekFirstDay + 6;
  const inWeek = rows
    .filter((r) => r.end >= weekFirstDay && r.start <= weekLast)
    .map((r) => ({
      ...r,
      startCol: Math.max(r.start, weekFirstDay) - weekFirstDay,
      endCol: Math.min(r.end, weekLast) - weekFirstDay,
    }))
    .sort((a, b) => a.startCol - b.startCol || b.endCol - b.startCol - (a.endCol - a.startCol));
  const lanes: number[] = []; // last column used per lane
  const bars: WeekBar[] = [];
  for (const r of inWeek) {
    let lane = lanes.findIndex((lastCol) => lastCol < r.startCol);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(-1);
    }
    lanes[lane] = r.endCol;
    bars.push({
      row: r.row,
      startCol: r.startCol,
      endCol: r.endCol,
      lane,
      continuesBefore: r.start < weekFirstDay,
      continuesAfter: r.end > weekLast,
    });
  }
  return { bars, lanes: lanes.length };
}

const shiftIso = (iso: string, days: number) => {
  const [day, time] = iso.split('T');
  const shifted = isoOfDay(dayIndex(dateFromString(day!)) + days);
  return time ? `${shifted}T${time}` : shifted;
};

/** A date value moved by whole days (times and the range's length are kept). */
export function shiftDateValue(value: DateValue, days: number): DateValue {
  return {
    ...value,
    start: shiftIso(value.start, days),
    ...(value.end ? { end: shiftIso(value.end, days) } : {}),
  };
}

/** A date value whose range ends on `day` (a single date when it's the start day). */
export function withEndDay(value: DateValue, day: number): DateValue {
  const start = dayIndex(dateFromString(value.start));
  const end = Math.max(start, day);
  const time = value.start.split('T')[1];
  const { end: _old, ...rest } = value;
  void _old;
  if (end === start) return rest;
  return { ...rest, end: time ? `${isoOfDay(end)}T${time}` : isoOfDay(end) };
}

/** A date value whose range starts on `day` (keeping the end). */
export function withStartDay(value: DateValue, day: number): DateValue {
  const end = value.end
    ? dayIndex(dateFromString(value.end))
    : dayIndex(dateFromString(value.start));
  const start = Math.min(day, end);
  const time = value.start.split('T')[1];
  const { end: oldEnd, ...rest } = value;
  const next: DateValue = { ...rest, start: time ? `${isoOfDay(start)}T${time}` : isoOfDay(start) };
  if (start !== end) next.end = oldEnd ?? isoOfDay(end);
  return next;
}
