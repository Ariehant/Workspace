/**
 * Google Calendar's events as the calendar shows them (pure: the main process reads and keeps
 * the items, see main/google/).
 *
 * Google sends a recurring event once (its "master", with `recurrence`), plus the occurrences
 * that differ from it (`recurringEventId` and `originalStartTime`): moved, renamed or cancelled.
 * The master is expanded here (recurrence.ts), and those occurrences replace or remove theirs.
 *
 * Timed events are real instants: they show at this machine's clock time for them (so not
 * `floating`), worked out again when the time zone changes.
 */
import { addDays, dayOf, diffDays, type Day } from './dates';
import { expand } from './recurrence';
import type { CalEvent, GoogleCalendar } from './types';
import { basicUtc, instantAt, wallAt } from './zones';

/** A start or end: a day for all-day events, else an RFC 3339 time and maybe a zone. */
export interface GoogleTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** The parts of Google's event resource the calendar uses. */
export interface GoogleEvent {
  id: string;
  status?: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: GoogleTime;
  end?: GoogleTime;
  endTimeUnspecified?: boolean;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  updated?: string;
}

/** The parts of a `calendarList` entry the calendar uses. */
export interface GoogleCalendarEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  backgroundColor?: string;
  accessRole?: string;
  timeZone?: string;
  primary?: boolean;
  hidden?: boolean;
  selected?: boolean;
}

/** An occurrence's key: its original start as a day, or as UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. */
export function occurrenceKey(time: GoogleTime): string | null {
  if (time.date) return time.date;
  if (time.dateTime) {
    const t = Date.parse(time.dateTime);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  return null;
}

/** The video call to join: Meet's link, or the conference's video entry point. */
export function meetLinkOf(event: GoogleEvent): string | null {
  const video = event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video');
  const link = event.hangoutLink ?? video?.uri ?? null;
  return link && /^https:\/\//.test(link) ? link : null;
}

interface Times {
  allDay: boolean;
  start: string;
  end: string;
  instant?: { start: string; end: string };
}

/** An event's times on this machine's clock (`zone`), or null if they can't be read. */
function timesOf(start: GoogleTime, end: GoogleTime | undefined, zone: string): Times | null {
  if (start.date) {
    // Google's all-day end is exclusive; the calendar's is the last day.
    const last = end?.date ? addDays(end.date, -1) : start.date;
    return { allDay: true, start: start.date, end: last > start.date ? last : start.date };
  }
  const s = start.dateTime ? Date.parse(start.dateTime) : NaN;
  if (Number.isNaN(s)) return null;
  let e = end?.dateTime ? Date.parse(end.dateTime) : NaN;
  if (Number.isNaN(e) || e < s) e = s;
  const instant = { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
  return { allDay: false, start: wallAt(s, zone), end: wallAt(e, zone), instant };
}

const plain = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();

/** One Google event (a single event or one occurrence) as the calendar's event. */
export function toCalEvent(
  calendar: GoogleCalendar,
  event: GoogleEvent,
  times: Times,
  extra: { sourceId?: string; series?: CalEvent['series'] } = {},
): CalEvent {
  const sourceId = extra.sourceId ?? event.id;
  const details: CalEvent['extra'] = [];
  if (event.location) details.push({ name: 'Location', value: event.location });
  if (event.description) details.push({ name: 'Description', value: plain(event.description) });
  const timeZone = event.start?.timeZone ?? calendar.timeZone;
  return {
    id: `${calendar.id}:${sourceId}`,
    calendarId: calendar.id,
    sourceId,
    title:
      event.summary?.trim() || (calendar.accessRole === 'freeBusyReader' ? 'Busy' : '(No title)'),
    allDay: times.allDay,
    start: times.start,
    end: times.end,
    endSet: !event.endTimeUnspecified,
    floating: false,
    url: event.htmlLink ?? null,
    colour: null,
    extra: details,
    lastEdited: event.updated ?? '',
    ...(times.instant && { instant: times.instant }),
    ...(timeZone && { timeZone }),
    ...(extra.series && { series: extra.series }),
    ...(event.etag && { etag: event.etag }),
    meetLink: meetLinkOf(event),
  };
}

const overlaps = (e: CalEvent, from: Day, to: Day) => dayOf(e.start) <= to && dayOf(e.end) >= from;

/**
 * A Google calendar's events in the window (days on this machine's clock, inclusive), from the
 * items kept for it.
 */
export function deriveEvents(
  calendar: GoogleCalendar,
  items: GoogleEvent[],
  window: { from: Day; to: Day },
  zone: string,
): CalEvent[] {
  const masters = new Map<string, GoogleEvent>();
  const occurrences = new Map<string, Map<string, GoogleEvent>>();
  const out: CalEvent[] = [];
  const push = (event: CalEvent | null) => {
    if (event && overlaps(event, window.from, window.to)) out.push(event);
  };

  for (const item of items) {
    if (item.recurrence?.length && !item.recurringEventId) masters.set(item.id, item);
    else if (item.recurringEventId) {
      const key = item.originalStartTime ? occurrenceKey(item.originalStartTime) : null;
      if (!key) continue;
      const of = occurrences.get(item.recurringEventId) ?? new Map<string, GoogleEvent>();
      of.set(key, item);
      occurrences.set(item.recurringEventId, of);
    } else if (item.status !== 'cancelled' && item.start) {
      const times = timesOf(item.start, item.end, zone);
      push(times && toCalEvent(calendar, item, times));
    }
  }

  // Occurrences that differ from their series (or whose series isn't here: an invitation to
  // one occurrence of someone else's series). Cancelled ones only hide theirs.
  for (const [seriesId, of] of occurrences) {
    for (const [key, item] of of) {
      if (item.status === 'cancelled' || !item.start) continue;
      const times = timesOf(item.start, item.end, zone);
      push(
        times &&
          toCalEvent(calendar, item, times, { series: { id: seriesId, originalStart: key } }),
      );
    }
  }

  for (const master of masters.values()) {
    if (master.status === 'cancelled' || !master.start) continue;
    const first = timesOf(master.start, master.end, zone);
    if (!first) continue;
    const allDay = first.allDay;
    const seriesZone = master.start.timeZone ?? calendar.timeZone;
    const durationMs = first.instant
      ? Date.parse(first.instant.end) - Date.parse(first.instant.start)
      : 0;
    const lengthDays = allDay ? diffDays(first.start, first.end) : 0;
    const start = allDay ? master.start.date! : wallAt(master.start.dateTime!, seriesZone);
    const changed = occurrences.get(master.id);
    // A day either side: the series' clock and this machine's can be a day apart.
    for (const occurrence of expand(
      { allDay, start, timeZone: seriesZone, rules: master.recurrence! },
      addDays(window.from, -2),
      addDays(window.to, 1),
    )) {
      if (changed?.has(occurrence.start)) continue;
      const key = occurrence.start;
      const times: Times = allDay
        ? { allDay, start: key, end: addDays(key, lengthDays) }
        : (() => {
            const s = Date.parse(key);
            const e = s + durationMs;
            return {
              allDay,
              start: wallAt(s, zone),
              end: wallAt(e, zone),
              instant: { start: key, end: new Date(e).toISOString() },
            };
          })();
      // No etag: the series' isn't this occurrence's (Google gives it one once changed).
      const { etag: _seriesEtag, ...instance } = toCalEvent(calendar, master, times, {
        sourceId: occurrenceId(master.id, key),
        series: { id: master.id, originalStart: key },
      });
      push(instance);
    }
  }
  return out;
}

/** The id Google gives an occurrence of a series: `<series>_<start, UTC or day>`. */
export const occurrenceId = (seriesId: string, key: string) =>
  `${seriesId}_${key.length === 10 ? key.replace(/-/g, '') : basicUtc(key)}`;

/**
 * A single event or one occurrence Google sent back (after an edit) as the calendar's event, or
 * null for a series (its occurrences are worked out at the next sync) or a cancelled one.
 */
export function eventFromGoogle(
  calendar: GoogleCalendar,
  item: GoogleEvent,
  zone: string,
): CalEvent | null {
  if (
    item.status === 'cancelled' ||
    !item.start ||
    (item.recurrence?.length && !item.recurringEventId)
  )
    return null;
  const times = timesOf(item.start, item.end, zone);
  if (!times) return null;
  const key =
    item.recurringEventId && item.originalStartTime ? occurrenceKey(item.originalStartTime) : null;
  return toCalEvent(
    calendar,
    item,
    times,
    item.recurringEventId && key
      ? { series: { id: item.recurringEventId, originalStart: key } }
      : {},
  );
}

/**
 * An event's time as Google takes it: days (Google's end is the day after), or real instants
 * for the wall times on this machine's clock (`zone`), with the zone the event belongs to.
 */
export function googleTimes(
  time: { allDay: boolean; start: string; end: string },
  zone: string,
  eventZone: string,
): { start: GoogleTime; end: GoogleTime } {
  if (time.allDay)
    return {
      start: { date: time.start.slice(0, 10) },
      end: { date: addDays(time.end.slice(0, 10), 1) },
    };
  return {
    start: { dateTime: instantAt(time.start, zone).toISOString(), timeZone: eventZone },
    end: { dateTime: instantAt(time.end, zone).toISOString(), timeZone: eventZone },
  };
}

/** A Google colour (`#9fe1e7`) or null if it isn't one. */
export const hexColour = (value: string | undefined): string | null =>
  value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null;
