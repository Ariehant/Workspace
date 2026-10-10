import type { DateFormat, NumberFormat, PropertyConfig, TimeFormat } from './schema';

const CURRENCIES: Partial<Record<NumberFormat, string>> = {
  dollar: 'USD',
  euro: 'EUR',
  pound: 'GBP',
  yen: 'JPY',
  rupee: 'INR',
  yuan: 'CNY',
  won: 'KRW',
  real: 'BRL',
  franc: 'CHF',
};

export const NUMBER_FORMATS: { id: NumberFormat; label: string }[] = [
  { id: 'number', label: 'Number' },
  { id: 'commas', label: 'Number with commas' },
  { id: 'percent', label: 'Percent' },
  { id: 'dollar', label: 'US dollar' },
  { id: 'euro', label: 'Euro' },
  { id: 'pound', label: 'Pound' },
  { id: 'yen', label: 'Yen' },
  { id: 'rupee', label: 'Rupee' },
  { id: 'yuan', label: 'Yuan' },
  { id: 'won', label: 'Won' },
  { id: 'real', label: 'Real' },
  { id: 'franc', label: 'Franc' },
];

export const DATE_FORMATS: { id: DateFormat; label: string }[] = [
  { id: 'full', label: 'Full date' },
  { id: 'mdy', label: 'Month/Day/Year' },
  { id: 'dmy', label: 'Day/Month/Year' },
  { id: 'ymd', label: 'Year/Month/Day' },
  { id: 'relative', label: 'Relative' },
];

export const TIME_FORMATS: { id: TimeFormat; label: string }[] = [
  { id: '12h', label: '12 hour' },
  { id: '24h', label: '24 hour' },
];

/** Number formatters by format and precision: making one is far slower than using it. */
const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(format: string, precision: number | undefined): Intl.NumberFormat {
  const key = `${format}:${precision ?? ''}`;
  let formatter = numberFormats.get(key);
  if (!formatter) {
    const digits =
      precision !== undefined
        ? { minimumFractionDigits: precision, maximumFractionDigits: precision }
        : {};
    formatter = new Intl.NumberFormat(
      'en-US',
      format === 'commas' || format === 'percent'
        ? { maximumFractionDigits: 10, ...digits }
        : { style: 'currency', currency: CURRENCIES[format as NumberFormat] ?? 'USD', ...digits },
    );
    numberFormats.set(key, formatter);
  }
  return formatter;
}

/** A number as its property shows it: `1,234.5`, `12%`, `$3.00`, ... */
export function formatNumber(n: number, config: PropertyConfig = {}): string {
  const format = config.numberFormat ?? 'number';
  if (format === 'number') {
    return config.precision !== undefined ? n.toFixed(config.precision) : String(n);
  }
  const text = numberFormat(format, config.precision).format(n);
  // Notion's percent shows the number as typed: 12 -> 12%.
  return format === 'percent' ? `${text}%` : text;
}

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** Local Date for a stored `YYYY-MM-DD[THH:mm]`. */
export function dateFromString(s: string): Date {
  const [day, time] = s.split('T');
  const [y, m, d] = day!.split('-').map(Number);
  const [hh, mm] = (time ?? '00:00').split(':').map(Number);
  return new Date(y!, m! - 1, d!, hh, mm);
}

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Whole days from `now`'s day to `date`'s day (negative in the past). */
export function dayOffset(date: Date, now: Date): number {
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / DAY_MS);
}

const fullDay = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' });

function formatDay(date: Date, format: DateFormat, now: Date): string {
  const [y, m, d] = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())];
  switch (format) {
    case 'mdy':
      return `${m}/${d}/${y}`;
    case 'dmy':
      return `${d}/${m}/${y}`;
    case 'ymd':
      return `${y}/${m}/${d}`;
    case 'relative': {
      const days = dayOffset(date, now);
      if (days === 0) return 'Today';
      if (days === 1) return 'Tomorrow';
      if (days === -1) return 'Yesterday';
      if (days > 1 && days < 7) return weekday.format(date);
      if (days < -1 && days > -7) return `Last ${weekday.format(date)}`;
      return fullDay.format(date);
    }
    default:
      return fullDay.format(date);
  }
}

function formatTime(date: Date, format: TimeFormat): string {
  if (format === '24h') return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const h = date.getHours() % 12 || 12;
  return `${h}:${pad(date.getMinutes())} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** A stored date (`YYYY-MM-DD[THH:mm]`) in the property's date and time format. */
export function formatDateString(s: string, config: PropertyConfig = {}, now = new Date()): string {
  const date = dateFromString(s);
  const day = formatDay(date, config.dateFormat ?? 'full', now);
  return s.includes('T') ? `${day} ${formatTime(date, config.timeFormat ?? '12h')}` : day;
}

/** A timestamp (created / edited time), always with the time. */
export function formatTimestamp(ms: number, config: PropertyConfig = {}, now = new Date()): string {
  const date = new Date(ms);
  return `${formatDay(date, config.dateFormat ?? 'full', now)} ${formatTime(
    date,
    config.timeFormat ?? '12h',
  )}`;
}
