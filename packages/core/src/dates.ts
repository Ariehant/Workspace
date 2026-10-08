/**
 * Natural-language dates for @-mentions and reminders: "today", "next fri",
 * "in 3 days", "oct 5", "2026-10-05", "5/10/2026" (day/month is ambiguous, so only
 * ISO and month-name forms are accepted). Dates are local calendar days as
 * `YYYY-MM-DD`; reminders add a time.
 */

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fromIsoDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d : null; // rejects 2026-02-31
}

/** Match a word that is a prefix (≥ 3 letters) of one of `names`; returns its index. */
function namePrefix(word: string, names: string[]): number {
  if (word.length < 3) return -1;
  return names.findIndex((n) => n.startsWith(word));
}

/** Parse a date phrase relative to `now`; `null` if it isn't one. */
export function parseDate(input: string, now = new Date()): Date | null {
  const q = input.trim().toLowerCase().replace(/\s+/g, ' ');
  const today = startOfDay(now);
  if (!q) return null;
  if ('today'.startsWith(q) && q.length >= 2) return today;
  if ('tomorrow'.startsWith(q) && q.length >= 3) return addDays(today, 1);
  if ('yesterday'.startsWith(q) && q.length >= 3) return addDays(today, -1);

  let m = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(q);
  if (m) return addDays(today, Number(m[1]) * (m[2]!.startsWith('week') ? 7 : 1));

  m = /^(next |last |this )?([a-z]+)$/.exec(q);
  if (m) {
    const day = namePrefix(m[2]!, WEEKDAYS);
    if (day >= 0) {
      let diff = (day - today.getDay() + 7) % 7;
      if (m[1] === 'last ') diff = diff === 0 ? -7 : diff - 7;
      else if (m[1] === 'next ' || diff === 0) diff = diff === 0 ? 7 : diff;
      return addDays(today, diff);
    }
  }

  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q);
  if (m) return fromIsoDate(`${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`);

  // "oct 5", "october 5 2027", "5 oct", "5 october 2027"
  m = /^([a-z]+) (\d{1,2})(?:,? (\d{4}))?$/.exec(q) ?? null;
  let monthWord: string | undefined;
  let dayNum: number | undefined;
  let year: number | undefined;
  if (m) [monthWord, dayNum, year] = [m[1], Number(m[2]), m[3] ? Number(m[3]) : undefined];
  else {
    const n = /^(\d{1,2}) ([a-z]+)(?: (\d{4}))?$/.exec(q);
    if (n) [dayNum, monthWord, year] = [Number(n[1]), n[2], n[3] ? Number(n[3]) : undefined];
  }
  if (monthWord && dayNum) {
    const month = namePrefix(monthWord, MONTHS);
    if (month < 0) return null;
    let d = new Date(year ?? today.getFullYear(), month, dayNum);
    if (d.getMonth() !== month) return null;
    // Without a year, pick the next occurrence (like Notion).
    if (year === undefined && d < today) d = new Date(today.getFullYear() + 1, month, dayNum);
    return d;
  }
  return null;
}

/** "Today", "Tomorrow", "Yesterday", "Friday" (within the next week), else "Oct 5, 2026". */
export function formatDate(iso: string, now = new Date()): string {
  const d = fromIsoDate(iso);
  if (!d) return iso;
  const days = Math.round((d.getTime() - startOfDay(now).getTime()) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Default reminder time on the chosen day: 9:00 local. */
export const REMINDER_HOUR = 9;

export function reminderTime(iso: string, timeZone?: string): number | null {
  const d = fromIsoDate(iso);
  if (!d) return null;
  return timeZone
    ? zonedTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), REMINDER_HOUR, 0, timeZone)
    : new Date(d.getFullYear(), d.getMonth(), d.getDate(), REMINDER_HOUR).getTime();
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** How far `timeZone`'s wall clock is ahead of UTC at instant `t` (ms). */
function zoneOffset(t: number, timeZone: string): number {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    zoneFormats.set(timeZone, format);
  }
  const parts: Record<string, number> = {};
  for (const p of format.formatToParts(t))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  const wall = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wall - Math.floor(t / 1000) * 1000;
}

/** Is `timeZone` an IANA zone this runtime knows ("Europe/Berlin")? */
export function isTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant (ms) a wall-clock time happens in an IANA time zone (`month` from 1). For
 * the server, which computes others' reminders; an unknown zone is taken as UTC.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (!isTimeZone(timeZone)) return wall;
  // Twice: the offset at the guess may differ from the offset at the answer (DST).
  let t = wall - zoneOffset(wall, timeZone);
  t = wall - zoneOffset(t, timeZone);
  return t;
}
