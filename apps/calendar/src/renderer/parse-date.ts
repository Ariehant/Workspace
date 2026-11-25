/** "Go to date" in the command bar: a day from what the user typed, or null. */
import { addDays, addMonths, weekday } from '../shared/dates';

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

const pad = (n: number) => String(n).padStart(2, '0');

function valid(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

const monthOf = (word: string) => {
  const w = word.toLowerCase().replace(/\.$/, '');
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(w));
};

/**
 * Understands: `2026-12-25`, `today`, `tomorrow`, `yesterday`, a weekday (`friday`, the next
 * one), `next week`, `next month`, and a month with a day (`dec 25`, `25 december`, `December 25
 * 2027`). A month and day without a year mean the next time that date comes (from `today`).
 */
export function parseDay(input: string, today: string): string | null {
  const text = input.trim().toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ');
  if (!text) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (iso) return valid(+iso[1]!, +iso[2]!, +iso[3]!);
  if (text === 'today') return today;
  if (text === 'tomorrow') return addDays(today, 1);
  if (text === 'yesterday') return addDays(today, -1);
  if (text === 'next week') return addDays(today, 7);
  if (text === 'next month') return addMonths(today, 1);
  const day = WEEKDAYS.findIndex(
    (w) => text.length >= 3 && w.startsWith(text.replace(/^next /, '')),
  );
  if (day !== -1) {
    const ahead = (day - weekday(today) + 7) % 7 || 7;
    return addDays(today, ahead);
  }
  const words = text.split(' ');
  let month = -1;
  let date = NaN;
  let year = NaN;
  for (const w of words) {
    if (/^\d{4}$/.test(w)) year = +w;
    else if (/^\d{1,2}(st|nd|rd|th)?$/.test(w)) date = parseInt(w, 10);
    else if (monthOf(w) !== -1 && month === -1) month = monthOf(w);
    else return null;
  }
  if (month === -1 || Number.isNaN(date)) return null;
  if (!Number.isNaN(year)) return valid(year, month + 1, date);
  const thisYear = +today.slice(0, 4);
  const candidate = valid(thisYear, month + 1, date);
  if (candidate && candidate >= today) return candidate;
  return valid(thisYear + 1, month + 1, date);
}
