/**
 * "Language and region": how dates, times and numbers look. The app's text is in English
 * (the only language so far); the region decides the formats, through the locale
 * `en-<REGION>` (English as written there: `en-DE` gives 17 Nov 2026, 24-hour time, weeks
 * from Monday and 1.234,5). Each format can also be set on its own.
 *
 * The formatting functions everywhere read the current region (`region()`), which the app
 * sets from the person's setting (`setRegion`) before it renders.
 */

/** The language of the app's text. */
export const UI_LANGUAGE = 'en';

export type DateStyle = 'full' | 'mdy' | 'dmy' | 'ymd';
export type HourCycle = '12h' | '24h';
export type WeekStart = 0 | 1;

/** The setting as stored: `null` (or missing) means "from the region". */
export interface RegionSettings {
  /** ISO 3166 region code, e.g. `US`, `GB`, `IN`, `DE`. */
  region?: string | null;
  date?: DateStyle | null;
  time?: HourCycle | null;
  weekStart?: WeekStart | null;
}

/** The formats in effect. */
export interface Region {
  /** The region code. */
  code: string;
  /** The BCP 47 locale formats use. */
  locale: string;
  date: DateStyle;
  time: HourCycle;
  weekStart: WeekStart;
}

export const REGION_SETTING = 'ui.region';

const DATE_STYLES: readonly DateStyle[] = ['full', 'mdy', 'dmy', 'ymd'];

/** The system's locale (the browser's or the OS's), e.g. `en-IN` or `de-DE`. */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
}

/** The region part of a locale (`de-DE` → `DE`); null for a bare language (`de`). */
export function regionOf(locale: string): string | null {
  try {
    return new Intl.Locale(locale).maximize().region ?? null;
  } catch {
    return null;
  }
}

const supported = (locale: string) => {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale]).length > 0;
  } catch {
    return false;
  }
};

/** Regions whose week starts on Sunday (CLDR), for runtimes without `Intl.Locale` week info. */
const SUNDAY_FIRST = new Set([
  'AG',
  'AS',
  'BD',
  'BR',
  'BS',
  'BT',
  'BW',
  'BZ',
  'CA',
  'CN',
  'CO',
  'DM',
  'DO',
  'ET',
  'GT',
  'GU',
  'HK',
  'HN',
  'ID',
  'IL',
  'IN',
  'JM',
  'JP',
  'KE',
  'KH',
  'KR',
  'LA',
  'MH',
  'MM',
  'MO',
  'MT',
  'MX',
  'MZ',
  'NI',
  'NP',
  'PA',
  'PE',
  'PH',
  'PK',
  'PR',
  'PT',
  'PY',
  'SA',
  'SG',
  'SV',
  'TH',
  'TT',
  'TW',
  'UM',
  'US',
  'VE',
  'VI',
  'WS',
  'YE',
  'ZA',
  'ZW',
]);

function localeWeekStart(locale: string, code: string): WeekStart {
  try {
    const info = new Intl.Locale(locale) as Intl.Locale & {
      getWeekInfo?(): { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const week = info.getWeekInfo?.() ?? info.weekInfo;
    // firstDay: 1 = Monday … 7 = Sunday; weeks from Saturday become Monday (the closer choice).
    if (week) return week.firstDay === 7 ? 0 : 1;
  } catch {
    // fall through to the table
  }
  return SUNDAY_FIRST.has(code) ? 0 : 1;
}

function localeHourCycle(locale: string): HourCycle {
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h11' || cycle === 'h12' ? '12h' : '24h';
  } catch {
    return '12h';
  }
}

/** The formats for a setting, filling what it leaves out from the region (or the system's). */
export function resolveRegion(settings: RegionSettings = {}, system = systemLocale()): Region {
  const wanted = settings.region?.toUpperCase() || regionOf(system) || 'US';
  const code = supported(`${UI_LANGUAGE}-${wanted}`) ? wanted : 'US';
  const locale = `${UI_LANGUAGE}-${code}`;
  return {
    code,
    locale,
    date: settings.date && DATE_STYLES.includes(settings.date) ? settings.date : 'full',
    time:
      settings.time === '12h' || settings.time === '24h' ? settings.time : localeHourCycle(locale),
    weekStart:
      settings.weekStart === 0 || settings.weekStart === 1
        ? settings.weekStart
        : localeWeekStart(locale, code),
  };
}

let current: Region = resolveRegion();

/** The formats in effect. */
export const region = (): Region => current;

/** Use these formats from now on (the app re-renders after). */
export function setRegion(next: Region): void {
  current = next;
}

/** Region codes to offer, named in English, sorted by name. */
export function regionChoices(): { code: string; name: string }[] {
  const names = new Intl.DisplayNames([UI_LANGUAGE], { type: 'region' });
  const codes = [
    'AE',
    'AR',
    'AT',
    'AU',
    'BD',
    'BE',
    'BR',
    'CA',
    'CH',
    'CL',
    'CN',
    'CO',
    'CZ',
    'DE',
    'DK',
    'EG',
    'ES',
    'FI',
    'FR',
    'GB',
    'GR',
    'HK',
    'HU',
    'ID',
    'IE',
    'IL',
    'IN',
    'IT',
    'JP',
    'KE',
    'KR',
    'LK',
    'MX',
    'MY',
    'NG',
    'NL',
    'NO',
    'NP',
    'NZ',
    'PH',
    'PK',
    'PL',
    'PT',
    'RO',
    'SA',
    'SE',
    'SG',
    'TH',
    'TR',
    'TW',
    'UA',
    'US',
    'VN',
    'ZA',
  ];
  return codes
    .filter((code) => supported(`${UI_LANGUAGE}-${code}`))
    .map((code) => ({ code, name: names.of(code) ?? code }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- Formatting -------------------------------------------------------------------------

const cache = new Map<string, Intl.DateTimeFormat | Intl.NumberFormat>();

/** A cached `Intl.DateTimeFormat` for the region (making one is slow; using one is fast). */
export function dateTimeFormat(
  options: Intl.DateTimeFormatOptions,
  r: Region = current,
): Intl.DateTimeFormat {
  const key = `d:${r.locale}:${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!format) {
    format = new Intl.DateTimeFormat(r.locale, options);
    cache.set(key, format);
  }
  return format;
}

/** A cached `Intl.NumberFormat` for the region. */
export function numberFormat(
  options: Intl.NumberFormatOptions,
  r: Region = current,
): Intl.NumberFormat {
  const key = `n:${r.locale}:${JSON.stringify(options)}`;
  let format = cache.get(key) as Intl.NumberFormat | undefined;
  if (!format) {
    format = new Intl.NumberFormat(r.locale, options);
    cache.set(key, format);
  }
  return format;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A calendar day in a date style: "Nov 17, 2026" / "17 Nov 2026", or 11/17/2026 and so on. */
export function formatDay(
  date: Date,
  style: DateStyle = current.date,
  r: Region = current,
): string {
  const [y, m, d] = [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())];
  switch (style) {
    case 'mdy':
      return `${m}/${d}/${y}`;
    case 'dmy':
      return `${d}/${m}/${y}`;
    case 'ymd':
      return `${y}/${m}/${d}`;
    default:
      return dateTimeFormat({ month: 'short', day: 'numeric', year: 'numeric' }, r).format(date);
  }
}

/** A time of day: "3:05 PM" or "15:05". */
export function formatTimeOfDay(date: Date, cycle: HourCycle = current.time): string {
  if (cycle === '24h') return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const h = date.getHours() % 12 || 12;
  return `${h}:${pad(date.getMinutes())} ${date.getHours() < 12 ? 'AM' : 'PM'}`;
}

/** A moment, as the app shows timestamps (history, comments, the inbox): day and time. */
export function formatDateTime(ms: number | Date, r: Region = current): string {
  const date = typeof ms === 'number' ? new Date(ms) : ms;
  return `${formatDay(date, r.date, r)} ${formatTimeOfDay(date, r.time)}`;
}

/** A day without its year ("Nov 17" / "17 Nov"), for recent things. */
export const formatShortDay = (date: Date, r: Region = current): string =>
  dateTimeFormat({ month: 'short', day: 'numeric' }, r).format(date);

/** The weekday's name ("Monday"). */
export const formatWeekday = (date: Date, r: Region = current): string =>
  dateTimeFormat({ weekday: 'long' }, r).format(date);

/** A month and year ("November 2026"). */
export const formatMonth = (date: Date, r: Region = current): string =>
  dateTimeFormat({ month: 'long', year: 'numeric' }, r).format(date);

/** A number with the region's decimal sign and, with `grouping`, its thousands separator. */
export const formatPlainNumber = (n: number, { grouping = false } = {}, r: Region = current) =>
  numberFormat({ maximumFractionDigits: 20, useGrouping: grouping }, r).format(n);
