/**
 * Dates in other apps' exports, as the database stores them: local `YYYY-MM-DD`, or
 * `YYYY-MM-DDTHH:mm` with a time.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** An ISO time (with its zone) → local `YYYY-MM-DDTHH:mm`. */
export function localTime(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${day(d.getFullYear(), d.getMonth() + 1, d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `YYYY-MM-DD` (Asana's dates), checked. */
export function isoDay(text: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  return date.getMonth() === mo - 1 && date.getDate() === d ? day(y, mo, d) : null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Jira's export dates: `19/Nov/26 3:04 PM` (its default format), with or without the time;
 * also `2026-11-19 15:04` and plain ISO days, which some sites are set to.
 */
export function jiraDate(text: string): string | null {
  const t = text.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(t);
  if (iso) {
    const d = isoDay(`${iso[1]}-${iso[2]}-${iso[3]}`);
    if (!d) return null;
    return iso[4] ? `${d}T${pad(Number(iso[4]))}:${iso[5]}` : d;
  }
  const m =
    /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*([AaPp][Mm]))?)?$/.exec(
      t,
    );
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase()) + 1;
  if (!month) return null;
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = isoDay(day(year, month, Number(m[1])));
  if (!d) return null;
  if (!m[4]) return d;
  let hour = Number(m[4]);
  const half = m[6]?.toLowerCase();
  if (half && (hour < 1 || hour > 12)) return null;
  if (half === 'pm' && hour !== 12) hour += 12;
  if (half === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${d}T${pad(hour)}:${m[5]}`;
}

/** A stored date (local) → its time in ms, for a row's created time. */
export function dateMs(date: string | null): number | undefined {
  if (!date) return undefined;
  const [d, time] = date.split('T');
  const [y, mo, da] = d!.split('-').map(Number);
  const [h, mi] = (time ?? '00:00').split(':').map(Number);
  return new Date(y!, mo! - 1, da!, h!, mi!).getTime();
}
