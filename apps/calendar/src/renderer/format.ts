/** Dates and times for display, in the system's language. Day strings are formatted as UTC dates
 * so no time zone moves them. */

const utc = (day: string, minutes = 0) =>
  new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 0, minutes));

const monthYear = new Intl.DateTimeFormat(undefined, {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const monthOnly = new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' });
const weekdayShort = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
const weekdayNarrow = new Intl.DateTimeFormat(undefined, { weekday: 'narrow', timeZone: 'UTC' });
const fullDay = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});
const time = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'UTC',
});
const hour = new Intl.DateTimeFormat(undefined, { hour: 'numeric', timeZone: 'UTC' });

export const formatMonthYear = (day: string) => monthYear.format(utc(day));
export const formatWeekday = (day: string) => weekdayShort.format(utc(day));
export const formatWeekdayNarrow = (day: string) => weekdayNarrow.format(utc(day));
export const formatFullDay = (day: string) => fullDay.format(utc(day));
export const dayNumber = (day: string) => String(+day.slice(8, 10));

/** "Nov 23 – 29, 2026" style title for a range of days. */
export function formatRange(first: string, last: string): string {
  const y1 = first.slice(0, 4);
  const y2 = last.slice(0, 4);
  const m1 = monthOnly.format(utc(first));
  const m2 = monthOnly.format(utc(last));
  if (first.slice(0, 7) === last.slice(0, 7)) return formatMonthYear(first);
  if (y1 === y2) return `${m1} – ${m2} ${y1}`;
  return `${m1} ${y1} – ${m2} ${y2}`;
}

/** A wall-clock time ("10:30 AM"), from minutes since midnight. */
export const formatTime = (minutes: number) => time.format(utc('2000-01-01', minutes));
/** An hour label for the grid ("10 AM"). */
export const formatHour = (h: number) => hour.format(utc('2000-01-01', h * 60));
