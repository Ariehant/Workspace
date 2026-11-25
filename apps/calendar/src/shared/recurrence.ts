/**
 * Recurring events, expanded here (Google sends a series once; v1.2's ICS and CalDAV sources
 * will too). Rules are RFC 5545 lines, as Google's `recurrence` holds them:
 * `RRULE:FREQ=WEEKLY;BYDAY=MO,WE`, `EXDATE;TZID=Europe/Berlin:20261202T090000`,
 * `RDATE;VALUE=DATE:20261224`.
 *
 * A series repeats on its own zone's wall clock: a weekly 09:00 meeting in Berlin stays at 09:00
 * in Berlin across daylight-saving changes. So the rule is expanded on a zone-less timeline
 * (wall times), and each occurrence is turned into an instant afterwards.
 */
import { RRule, RRuleSet } from 'rrule';
import { addDays, type Day, type WallTime } from './dates';
import { instantAt, wallAt } from './zones';

export interface Series {
  allDay: boolean;
  /** The first occurrence: a day, or a wall time in `timeZone`. */
  start: Day | WallTime;
  /** The series' zone (ignored for all-day series). */
  timeZone: string;
  /** RRULE, EXRULE, RDATE and EXDATE lines. */
  rules: string[];
}

/** One occurrence, identified by when it starts. */
export interface Occurrence {
  /** All-day: the day. Timed: the start, UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
  start: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A wall time or day as a Date on the zone-less timeline rrule works on. */
function floating(value: Day | WallTime): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(value);
  if (!m) throw new Error(`Not a date: ${value}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0)));
}

function wallOf(d: Date): WallTime {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(
    d.getUTCHours(),
  )}:${pad(d.getUTCMinutes())}`;
}

const dayOfDate = (d: Date): Day => wallOf(d).slice(0, 10);

/** `20261202T090000Z`, `20261202T090000` or `20261202` as parts. */
function parseBasic(value: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const day = `${m[1]}-${m[2]}-${m[3]}`;
  if (!m[4]) return { day, wall: null, utc: false };
  return { day, wall: `${day}T${m[4]}:${m[5]}`, utc: !!m[7] };
}

/**
 * A date value from an RDATE or EXDATE line, on the series' timeline: the series' zone wall time
 * (or day for an all-day series).
 */
function datesOf(line: string, series: Series): Date[] {
  const colon = line.indexOf(':');
  if (colon < 0) return [];
  const params = line.slice(0, colon).split(';').slice(1);
  const tzid = params.find((p) => p.toUpperCase().startsWith('TZID='))?.slice(5);
  const out: Date[] = [];
  for (const raw of line.slice(colon + 1).split(',')) {
    const parsed = parseBasic(raw.split('/')[0]!); // A PERIOD's start.
    if (!parsed) continue;
    if (series.allDay || !parsed.wall) {
      out.push(
        floating(series.allDay ? parsed.day : `${parsed.day}T${series.start.slice(11, 16)}`),
      );
      continue;
    }
    let wall = parsed.wall;
    if (parsed.utc) wall = wallAt(`${wall}:00Z`, series.timeZone);
    else if (tzid && tzid !== series.timeZone)
      wall = wallAt(instantAt(wall, tzid), series.timeZone);
    out.push(floating(wall));
  }
  return out;
}

/** An RRULE (or EXRULE) on the series' timeline (its UNTIL moved there too). */
function ruleOf(line: string, series: Series, dtstart: Date): RRule | null {
  const body = line.slice(line.indexOf(':') + 1);
  let options;
  try {
    options = RRule.parseString(body);
  } catch {
    return null;
  }
  const until = /(?:^|;)UNTIL=([^;]+)/i.exec(body)?.[1];
  if (until) {
    const parsed = parseBasic(until);
    if (!parsed) return null;
    options.until = series.allDay
      ? floating(parsed.day)
      : parsed.wall && parsed.utc
        ? floating(wallAt(`${parsed.wall}:00Z`, series.timeZone))
        : parsed.wall
          ? floating(parsed.wall)
          : // A date UNTIL on a timed series: through that day.
            new Date(floating(parsed.day).getTime() + 86_399_000);
  }
  try {
    const rule = new RRule({ ...options, dtstart, tzid: null });
    // DTSTART is the first occurrence and counts towards COUNT even when the rule wouldn't
    // produce it (RFC 5545 3.8.5.3), so the rule itself yields one fewer.
    if (options.count && rule.after(dtstart, true)?.getTime() !== dtstart.getTime()) {
      if (options.count <= 1) return null;
      return new RRule({ ...options, count: options.count - 1, dtstart, tzid: null });
    }
    return rule;
  } catch {
    return null;
  }
}

/**
 * The series' occurrences starting between `from` and `to` (days on the series' own clock,
 * inclusive), oldest first. Callers widen the range by a day or two for other zones.
 */
export function expand(series: Series, from: Day, to: Day): Occurrence[] {
  const dtstart = floating(series.start);
  const set = new RRuleSet();
  set.rdate(dtstart);
  for (const line of series.rules) {
    const name = line.slice(0, line.search(/[;:]/)).toUpperCase();
    if (name === 'RRULE' || name === 'EXRULE') {
      const rule = ruleOf(line, series, dtstart);
      if (!rule) continue;
      if (name === 'RRULE') set.rrule(rule);
      else set.exrule(rule);
    } else if (name === 'RDATE') {
      for (const d of datesOf(line, series)) set.rdate(d);
    } else if (name === 'EXDATE') {
      for (const d of datesOf(line, series)) set.exdate(d);
    }
  }
  const after = floating(from);
  const before = new Date(floating(addDays(to, 1)).getTime() - 1);
  return set.between(after, before, true).map((d) => ({
    start: series.allDay ? dayOfDate(d) : instantAt(wallOf(d), series.timeZone).toISOString(),
  }));
}
