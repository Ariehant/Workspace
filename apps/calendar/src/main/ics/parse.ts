/**
 * iCalendar (RFC 5545) feeds read with ical.js, as the calendar's source events (the model
 * shared with Google, see shared/google.ts), so the same code expands their series and shows
 * them.
 *
 * - Times: a day (`VALUE=DATE`), UTC (`Z`), a zone (`TZID`), or floating (neither: the same
 *   clock time anywhere). A `TZID` is used as an IANA zone when it is one, or names one
 *   (Outlook's Windows names, Mozilla's `/mozilla.org/…/Europe/Berlin`); otherwise the feed's
 *   own `VTIMEZONE` gives the instant (and a series repeats in the feed's zone).
 * - Series: `RRULE`, `RDATE`, `EXDATE` and `EXRULE` are kept as their lines for `expand`;
 *   `RECURRENCE-ID` events replace (or, cancelled, remove) the occurrence they name.
 * - Ids: the calendar's event ids allow only letters, digits, `_` and `-`, so a `UID` with
 *   other characters (`…@google.com`) is replaced by a hash of it.
 */
import { createHash } from 'node:crypto';
import ICAL from 'ical.js';
import {
  occurrenceId,
  occurrenceKey,
  type GoogleEvent,
  type GoogleTime,
} from '../../shared/google';
import { instantAt, isZone } from '../../shared/zones';

export interface ParsedFeed {
  /** `X-WR-CALNAME`, if the feed names itself. */
  name: string | null;
  /** `X-WR-TIMEZONE`, if it's an IANA zone. */
  timeZone: string | null;
  items: GoogleEvent[];
}

export class IcsParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsParseError';
  }
}

/** Windows' zone names (Outlook and Exchange feeds) for the zones people use most. */
const WINDOWS_ZONES: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  UTC: 'UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  'Arabian Standard Time': 'Asia/Dubai',
  'Arab Standard Time': 'Asia/Riyadh',
  'Iran Standard Time': 'Asia/Tehran',
  'Pakistan Standard Time': 'Asia/Karachi',
  'India Standard Time': 'Asia/Kolkata',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Kathmandu',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'W. Australia Standard Time': 'Australia/Perth',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/** The IANA zone a `TZID` names, or null. */
export function ianaZone(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  const id = tzid.trim().replace(/^"|"$/g, '');
  const canonical = (zone: string) => (zone === 'Asia/Calcutta' ? 'Asia/Kolkata' : zone);
  if (isZone(id) && /\//.test(id)) return canonical(id);
  if (id === 'UTC' || id === 'GMT' || id === 'Z') return 'UTC';
  const windows = WINDOWS_ZONES[id];
  if (windows) return windows;
  // A path ending in a zone name: `/mozilla.org/20050126_1/Europe/Berlin`, `/citadel.org/…`.
  const tail = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id)?.[1];
  return tail && isZone(tail) ? canonical(tail) : null;
}

/** An id the calendar can use (letters, digits, `_`, `-`) for a `UID`. */
export function safeId(uid: string): string {
  return /^[\w-]{1,80}$/.test(uid)
    ? uid
    : `h${createHash('sha256')
        .update(uid)
        .digest('base64url')
        .slice(0, 27)
        .replace(/[^\w-]/g, '')}`;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const wallOf = (t: ICAL.Time) =>
  `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}T${pad(t.hour)}:${pad(t.minute)}`;
const dayOf = (t: ICAL.Time) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;

/** A date or date-time property as a source time. */
function timeOf(prop: ICAL.Property | null): GoogleTime | null {
  if (!prop) return null;
  const value = prop.getFirstValue();
  if (!(value instanceof ICAL.Time)) return null;
  if (value.isDate) return { date: dayOf(value) };
  const tzid = prop.getParameter('tzid');
  const zoneId = typeof tzid === 'string' ? tzid : null;
  if (!zoneId && value.zone?.tzid === 'UTC')
    return { dateTime: value.toJSDate().toISOString(), timeZone: 'UTC' };
  if (!zoneId) return { wall: wallOf(value) };
  const iana = ianaZone(zoneId);
  if (iana) {
    // The wall time in that zone, to an instant (zones.ts, through Intl).
    return { dateTime: instantIn(wallOf(value), value.second, iana), timeZone: iana };
  }
  // A zone only the feed's VTIMEZONE knows: ical.js works out the instant.
  if (value.zone && value.zone.tzid !== 'floating')
    return { dateTime: new Date(value.toUnixTime() * 1000).toISOString() };
  // Unknown and undefined: read it as floating.
  return { wall: wallOf(value) };
}

/** A wall time (and its seconds) in an IANA zone, as an instant. */
const instantIn = (wall: string, seconds: number, zone: string) =>
  new Date(instantAt(wall, zone).getTime() + seconds * 1000).toISOString();

const text = (event: ICAL.Component, name: string): string | undefined => {
  const value = event.getFirstPropertyValue(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
};

/** `RRULE`, `RDATE`, `EXDATE`, `EXRULE` lines, with zone names `expand` can read. */
function rulesOf(event: ICAL.Component): string[] {
  const lines: string[] = [];
  for (const name of ['rrule', 'rdate', 'exdate', 'exrule']) {
    for (const prop of event.getAllProperties(name)) {
      const tzid = prop.getParameter('tzid');
      if (typeof tzid === 'string') {
        const iana = ianaZone(tzid);
        if (iana) prop.setParameter('tzid', iana);
      }
      lines.push(prop.toICALString().replace(/\r?\n[ \t]/g, ''));
    }
  }
  return lines;
}

/** Parse a feed; throws `IcsParseError` for what isn't iCalendar. */
export function parseIcs(source: string): ParsedFeed {
  let root: ICAL.Component;
  try {
    const jcal = ICAL.parse(source.replace(/^\uFEFF/, ''));
    root = new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
  } catch (error) {
    throw new IcsParseError(
      `This isn't a calendar feed (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  if (root.name !== 'vcalendar') throw new IcsParseError("This isn't a calendar feed.");

  // The feed's own zones, so ical.js can place times in zones Intl doesn't know. Its registry is
  // global: they're taken out again once this feed is read (another feed's zone of the same
  // name can differ).
  const registered: string[] = [];
  for (const vtimezone of root.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtimezone);
      if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) {
        ICAL.TimezoneService.register(zone);
        registered.push(zone.tzid);
      }
    } catch {
      // A broken VTIMEZONE: its times are read as floating.
    }
  }
  try {
    return readEvents(root);
  } finally {
    for (const tzid of registered) ICAL.TimezoneService.remove(tzid);
  }
}

/** The feed's events (values are read lazily, here, so they find the feed's zones). */
function readEvents(calendar: ICAL.Component): ParsedFeed {
  const items: GoogleEvent[] = [];
  for (const vevent of calendar.getAllSubcomponents('vevent')) {
    const start = timeOf(vevent.getFirstProperty('dtstart'));
    if (!start) continue;
    const uid = text(vevent, 'uid') ?? createHash('sha256').update(vevent.toString()).digest('hex');
    const id = safeId(uid);
    let end = timeOf(vevent.getFirstProperty('dtend'));
    if (!end) {
      const duration = vevent.getFirstPropertyValue('duration');
      const startValue = vevent.getFirstPropertyValue('dtstart');
      if (duration instanceof ICAL.Duration && startValue instanceof ICAL.Time) {
        const endValue = startValue.clone();
        endValue.addDuration(duration);
        const endProp = new ICAL.Property('dtend');
        const tzid = vevent.getFirstProperty('dtstart')!.getParameter('tzid');
        if (typeof tzid === 'string') endProp.setParameter('tzid', tzid);
        endProp.setValue(endValue);
        end = timeOf(endProp);
      } else if (start.date) {
        // A day with no end is that one day (Google's end is the day after).
        const next = new Date(`${start.date}T00:00:00Z`);
        next.setUTCDate(next.getUTCDate() + 1);
        end = { date: next.toISOString().slice(0, 10) };
      }
    }
    const recurrenceId = timeOf(vevent.getFirstProperty('recurrence-id'));
    const updated =
      vevent.getFirstPropertyValue('last-modified') ?? vevent.getFirstPropertyValue('dtstamp');
    const status = text(vevent, 'status')?.toUpperCase();
    const rules = recurrenceId ? [] : rulesOf(vevent);
    const location = text(vevent, 'location');
    const description = text(vevent, 'description');
    const link = text(vevent, 'url');
    const key = recurrenceId && occurrenceKey(recurrenceId);
    items.push({
      id: recurrenceId && key ? occurrenceId(id, key) : id,
      status:
        status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed',
      summary: text(vevent, 'summary'),
      ...(location && { location }),
      ...((description || link) && {
        description: [description, link && /^https?:\/\//.test(link) ? link : undefined]
          .filter(Boolean)
          .join('\n\n'),
      }),
      start,
      ...(end && { end }),
      ...(rules.some((r) => /^RRULE/i.test(r)) || rules.some((r) => /^RDATE/i.test(r))
        ? { recurrence: rules }
        : {}),
      ...(recurrenceId && { recurringEventId: id, originalStartTime: recurrenceId }),
      ...(updated instanceof ICAL.Time && { updated: updated.toJSDate().toISOString() }),
    });
  }

  const zone = calendar.getFirstPropertyValue('x-wr-timezone');
  const name = calendar.getFirstPropertyValue('x-wr-calname');
  return {
    name: typeof name === 'string' && name.trim() ? name.trim() : null,
    timeZone: typeof zone === 'string' ? ianaZone(zone) : null,
    items,
  };
}
