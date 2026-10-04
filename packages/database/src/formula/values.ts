import { isDate, isPage, isPerson, type FDate, type FValue } from './types';

const DAY_MS = 86_400_000;
const fullDate = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});
const timeOfDay = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });

function formatOneDate(ms: number, time: boolean): string {
  const d = new Date(ms);
  return time ? `${fullDate.format(d)} ${timeOfDay.format(d)}` : fullDate.format(d);
}

/** A number as formulas show it: no float noise (0.1 + 0.2 shows 0.3). */
export function formatNumberValue(n: number): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? 'Infinity' : '-Infinity';
  return String(Math.round(n * 1e12) / 1e12);
}

/** Text of any value, as `format()` gives it. */
export function formatValue(v: FValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return formatNumberValue(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(formatValue).join(', ');
  if (isDate(v)) {
    const start = formatOneDate(v.start, v.time);
    return v.end !== null ? `${start} → ${formatOneDate(v.end, v.time)}` : start;
  }
  if (isPerson(v)) return v.name;
  if (isPage(v)) return v.title;
  return '';
}

/** Notion's `empty()`: empty values, "", 0, false and [] are empty. */
export function isEmptyValue(v: FValue): boolean {
  return v === null || v === '' || v === 0 || v === false || (Array.isArray(v) && v.length === 0);
}

export function valuesEqual(a: FValue, b: FValue): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => valuesEqual(x, b[i]!))
    );
  }
  if (isDate(a) && isDate(b)) return a.start === b.start && a.end === b.end;
  if (isPerson(a) && isPerson(b)) return a.id === b.id;
  if (isPage(a) && isPage(b)) return a.id === b.id;
  return false;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Order of two values of the same kind (numbers, text, dates, booleans). */
export function compareValues(a: FValue, b: FValue): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  if (isDate(a) && isDate(b)) return a.start - b.start;
  return collator.compare(formatValue(a), formatValue(b));
}

// --- Dates ----------------------------------------------------------------------------

export const dateValue = (start: number, time: boolean, end: number | null = null): FDate => ({
  kind: 'date',
  start,
  end,
  time,
});

const UNITS: Record<string, string> = {
  year: 'years',
  years: 'years',
  quarter: 'quarters',
  quarters: 'quarters',
  month: 'months',
  months: 'months',
  week: 'weeks',
  weeks: 'weeks',
  day: 'days',
  days: 'days',
  hour: 'hours',
  hours: 'hours',
  minute: 'minutes',
  minutes: 'minutes',
  second: 'seconds',
  seconds: 'seconds',
  millisecond: 'milliseconds',
  milliseconds: 'milliseconds',
};

export function normalizeUnit(unit: string): string | null {
  return UNITS[unit.trim().toLowerCase()] ?? null;
}

/** Add `n` calendar units to a timestamp (months clamp to the month's last day). */
export function addUnits(ms: number, n: number, unit: string): number {
  const d = new Date(ms);
  const shiftMonths = (months: number) => {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + months);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, last));
  };
  switch (unit) {
    case 'years':
      shiftMonths(12 * n);
      break;
    case 'quarters':
      shiftMonths(3 * n);
      break;
    case 'months':
      shiftMonths(n);
      break;
    case 'weeks':
      d.setDate(d.getDate() + 7 * n);
      break;
    case 'days':
      d.setDate(d.getDate() + n);
      break;
    case 'hours':
      return ms + n * 3_600_000;
    case 'minutes':
      return ms + n * 60_000;
    case 'seconds':
      return ms + n * 1000;
    case 'milliseconds':
      return ms + n;
  }
  return d.getTime();
}

/** Whole units from `b` to `a` (positive when `a` is later), truncated toward zero. */
export function unitsBetween(a: number, b: number, unit: string): number {
  const trunc = (x: number) => (x < 0 ? Math.ceil(x) : Math.floor(x)) || 0;
  switch (unit) {
    case 'years':
    case 'quarters':
    case 'months': {
      const [late, early, sign] = a >= b ? [a, b, 1] : [b, a, -1];
      const l = new Date(late);
      const e = new Date(early);
      let months = (l.getFullYear() - e.getFullYear()) * 12 + l.getMonth() - e.getMonth();
      if (addUnits(early, months, 'months') > late) months--;
      const per = unit === 'years' ? 12 : unit === 'quarters' ? 3 : 1;
      return sign * Math.floor(months / per);
    }
    case 'weeks':
      return trunc((a - b) / (7 * DAY_MS));
    case 'days':
      return trunc((a - b) / DAY_MS);
    case 'hours':
      return trunc((a - b) / 3_600_000);
    case 'minutes':
      return trunc((a - b) / 60_000);
    case 'seconds':
      return trunc((a - b) / 1000);
    default:
      return a - b;
  }
}

export const startOfDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** ISO week number (weeks start on Monday; week 1 holds the first Thursday). */
export function isoWeek(ms: number): number {
  const d = new Date(startOfDay(ms));
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + 3);
  const firstThursday = new Date(d.getFullYear(), 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDay + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** Format a date with moment-style tokens (YYYY, MMMM, Do, HH:mm, ...); `[text]` is literal. */
export function formatDateTokens(ms: number, format: string): string {
  const d = new Date(ms);
  const dayOfYear =
    Math.round((startOfDay(ms) - new Date(d.getFullYear(), 0, 1).getTime()) / DAY_MS) + 1;
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => pad(d.getFullYear() % 100),
    Q: () => String(Math.floor(d.getMonth() / 3) + 1),
    MMMM: () => MONTHS[d.getMonth()]!,
    MMM: () => MONTHS[d.getMonth()]!.slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DDDD: () => pad(dayOfYear, 3),
    DDD: () => String(dayOfYear),
    Do: () => ordinal(d.getDate()),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => WEEKDAYS[d.getDay()]!,
    ddd: () => WEEKDAYS[d.getDay()]!.slice(0, 3),
    dd: () => WEEKDAYS[d.getDay()]!.slice(0, 2),
    d: () => String(d.getDay()),
    WW: () => pad(isoWeek(ms)),
    W: () => String(isoWeek(ms)),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(d.getHours() % 12 || 12),
    h: () => String(d.getHours() % 12 || 12),
    mm: () => pad(d.getMinutes()),
    m: () => String(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    s: () => String(d.getSeconds()),
    A: () => (d.getHours() < 12 ? 'AM' : 'PM'),
    a: () => (d.getHours() < 12 ? 'am' : 'pm'),
    X: () => String(Math.floor(ms / 1000)),
    x: () => String(ms),
  };
  const pattern =
    /\[([^\]]*)\]|YYYY|YY|Q|MMMM|MMM|MM|M|DDDD|DDD|Do|DD|D|dddd|ddd|dd|d|WW|W|HH|H|hh|h|mm|m|ss|s|A|a|X|x/g;
  return format.replace(pattern, (match, literal: string | undefined) =>
    literal !== undefined ? literal : tokens[match]!(),
  );
}

/** Parse an ISO date (`2026-10-04`, `2026-10-04T15:30[:00][Z]`) into a date value. */
export function parseIsoDate(text: string): FDate | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(
      text.trim(),
    );
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, zone] = m;
  if (zone) {
    const ms = Date.parse(text.trim());
    return Number.isNaN(ms) ? null : dateValue(ms, true);
  }
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh ?? 0),
    Number(mm ?? 0),
    Number(ss ?? 0),
  );
  if (date.getMonth() !== Number(mo) - 1) return null;
  return dateValue(date.getTime(), hh !== undefined);
}
