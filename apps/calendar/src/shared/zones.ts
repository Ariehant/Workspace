/**
 * Wall-clock times in IANA time zones and the real instants they name, through `Intl` (no zone
 * data of our own: the runtime's ICU has it).
 *
 * Wall times are `YYYY-MM-DDTHH:mm` (see dates.ts). A wall time that doesn't exist (a
 * daylight-saving gap) moves forward by the gap; one that happens twice (the hour repeated in
 * autumn) is the first of the two, as RFC 5545 says.
 */
import type { Day, WallTime } from './dates';

const HOUR_MS = 3_600_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** The fields of an instant's wall clock in `zone`, as milliseconds on a zone-less timeline. */
function wallMs(zone: string, instant: number): number {
  const p: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}

/** How far `zone`'s clock is ahead of UTC at `instant` (ms). */
export function zoneOffset(zone: string, instant: number): number {
  const whole = instant - (((instant % 1000) + 1000) % 1000);
  return wallMs(zone, whole) - whole;
}

/** Whether the runtime knows the zone. */
export function isZone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** This machine's time zone. */
export const localZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

function wallFromMs(t: number): WallTime {
  const d = new Date(t);
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

function msFromWall(wall: WallTime | Day): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(wall);
  if (!m) throw new Error(`Not a date: ${wall}`);
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** The wall-clock time in `zone` at an instant. */
export function wallAt(instant: Date | number | string, zone: string): WallTime {
  const t = new Date(instant).getTime();
  return wallFromMs(t + zoneOffset(zone, t));
}

/** The instant a wall-clock time (or a day's midnight) in `zone` names. */
export function instantAt(wall: WallTime | Day, zone: string): Date {
  const local = msFromWall(wall);
  // The offsets half a day either side: a zone changes its offset at most once in a day.
  const before = zoneOffset(zone, local - 12 * HOUR_MS);
  const after = zoneOffset(zone, local + 12 * HOUR_MS);
  const candidates = [local - before, local - after].filter(
    (t) => t + zoneOffset(zone, t) === local,
  );
  // Twice: the earlier. Never (a gap): the offset before the change, which moves it forward.
  return new Date(candidates.length ? Math.min(...candidates) : local - before);
}

/** An instant as Google writes ids and `UNTIL`: `YYYYMMDDTHHMMSSZ`. */
export function basicUtc(instant: Date | number | string): string {
  return new Date(instant)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
}
