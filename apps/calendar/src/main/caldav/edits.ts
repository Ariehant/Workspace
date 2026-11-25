/**
 * Edits made here, sent to a CalDAV server (HANDOFF.md 5), for the outbox. An event is one
 * iCalendar object on the server (a series keeps its exceptions in the same object), changed
 * with `PUT` and `If-Match: <etag>`:
 * - **create:** a new object, `If-None-Match: *`;
 * - **change:** the event's `VEVENT` rewritten (properties the calendar doesn't touch are kept);
 * - **delete:** `DELETE`.
 *
 * A recurring event's occurrence changes as the person chose:
 * - **This event:** an exception (`RECURRENCE-ID`) in the same object; deleting it adds an
 *   `EXDATE`;
 * - **All events:** the series moved as much as the occurrence was (its `BYDAY` too);
 * - **This and following:** the series ends before it (`UNTIL`) and a new object starts there,
 *   with what's left of a `COUNT`.
 *
 * If the object changed on the server meanwhile (`412`), the server's version is read, kept to
 * show as "Changed elsewhere", and the edit applied to it and sent again: the last write wins,
 * as for Workspace and Google.
 */
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import { addDays, diffDays, diffMinutes, syncWindow, type EventTime } from '../../shared/dates';
import { expand } from '../../shared/recurrence';
import type { CalDavCalendar, CalEvent, Calendar } from '../../shared/types';
import { instantAt, localZone, wallAt } from '../../shared/zones';
import type { Cache } from '../cache';
import { shiftWeekdays } from '../google/edits';
import { parseIcs, timeOf } from '../ics/parse';
import type { EditContext, EditTarget, UpdateResult } from '../outbox';
import { occurrenceKey } from '../../shared/google';
import { CalDavError, type CalDavClient } from './dav';
import { deriveCalDav, type StoredObject } from './sync';

type Change = { title?: string; time?: EventTime };

/** A value for an occurrence's key: a day, a UTC instant, or a floating clock time. */
function timeForKey(key: string): ICAL.Time {
  if (key.length === 10) return ICAL.Time.fromDateString(key);
  if (key.length === 16) return ICAL.Time.fromDateTimeString(`${key}:00`);
  return ICAL.Time.fromJSDate(new Date(key), true);
}

/** A time as the server should store it: a day, floating, or UTC. */
function icalTime(value: string, allDay: boolean, floating: boolean, zone: string): ICAL.Time {
  if (allDay) return ICAL.Time.fromDateString(value.slice(0, 10));
  if (floating) return ICAL.Time.fromDateTimeString(`${value.slice(0, 16)}:00`);
  return ICAL.Time.fromJSDate(instantAt(value, zone), true);
}

function setTime(
  vevent: ICAL.Component,
  name: 'dtstart' | 'dtend' | 'recurrence-id',
  time: ICAL.Time,
) {
  vevent.removeAllProperties(name);
  const prop = new ICAL.Property(name, vevent);
  prop.setValue(time);
  vevent.addProperty(prop);
}

/** A VEVENT's start and end set from an event time (this machine's clock times). */
function setTimes(vevent: ICAL.Component, time: EventTime, floating: boolean, zone: string) {
  vevent.removeAllProperties('duration');
  setTime(vevent, 'dtstart', icalTime(time.start, time.allDay, floating, zone));
  // iCalendar's all-day end is the day after the last.
  setTime(
    vevent,
    'dtend',
    time.allDay
      ? ICAL.Time.fromDateString(addDays(time.end.slice(0, 10), 1))
      : icalTime(time.end, false, floating, zone),
  );
}

const stamp = (vevent: ICAL.Component) => {
  const now = ICAL.Time.fromJSDate(new Date(), true);
  vevent.updatePropertyWithValue('dtstamp', now);
  vevent.updatePropertyWithValue('last-modified', now);
  const sequence = vevent.getFirstPropertyValue('sequence');
  vevent.updatePropertyWithValue('sequence', (typeof sequence === 'number' ? sequence : 0) + 1);
};

const keyOf = (vevent: ICAL.Component) => {
  const time = timeOf(vevent.getFirstProperty('recurrence-id'));
  return time && occurrenceKey(time);
};

/** The object's events: the series (or single event) and its exceptions. */
function partsOf(ics: string) {
  const root = new ICAL.Component(ICAL.parse(ics));
  const vevents = root.getAllSubcomponents('vevent');
  const master = vevents.find((v) => !v.hasProperty('recurrence-id')) ?? null;
  return { root, vevents, master };
}

/** The rule ended just before the occurrence `key`; exceptions from it on dropped. */
function endBefore(root: ICAL.Component, master: ICAL.Component, key: string) {
  const prop = master.getFirstProperty('rrule');
  const recur = prop?.getFirstValue();
  if (prop && recur instanceof ICAL.Recur) {
    const start = master.getFirstPropertyValue('dtstart');
    const until =
      key.length === 10
        ? ICAL.Time.fromDateString(addDays(key, -1))
        : start instanceof ICAL.Time && !start.zone?.tzid?.match(/UTC/) && key.length === 16
          ? ICAL.Time.fromDateTimeString(`${key}:00`)
          : ICAL.Time.fromJSDate(new Date(Date.parse(key) - 1000), true);
    if (key.length === 16) until.adjust(0, 0, -1, 0);
    recur.until = until;
    recur.count = null as unknown as number;
    prop.setValue(recur);
  }
  for (const vevent of root.getAllSubcomponents('vevent')) {
    const k = keyOf(vevent);
    if (k && k >= key) root.removeSubcomponent(vevent);
  }
}

export class CalDavEditTarget implements EditTarget {
  constructor(
    private readonly options: {
      cache: Cache;
      client: CalDavClient;
      zone?: () => string;
      /** Work a calendar's events out again (after its objects changed here). */
      rederive: (calendar: CalDavCalendar) => void;
    },
  ) {}

  private get zone() {
    return (this.options.zone ?? localZone)();
  }

  private stored(calendar: CalDavCalendar, resourceId: string): StoredObject {
    const item = this.options.cache
      .items<StoredObject>(calendar.id)
      .find((i) => i.sourceId === resourceId);
    if (!item) throw new CalDavError('not_found', 'The event is no longer on the server.', 404);
    return item.data;
  }

  private keep(calendar: CalDavCalendar, resourceId: string, object: StoredObject) {
    this.options.cache.putItem(calendar.id, { sourceId: resourceId, seriesId: null, data: object });
  }

  /** The event `id` as the object `ics` has it now (for the panel), or null. */
  private eventIn(calendar: CalDavCalendar, ics: string, id: string): CalEvent | null {
    const window = syncWindow();
    const events = deriveCalDav(calendar, [{ href: '', etag: null, ics }], window, this.zone);
    return events.find((e) => e.id === id) ?? null;
  }

  async create(calendar: Calendar, title: string, time: EventTime) {
    const dav = calendar as CalDavCalendar;
    const uid = randomUUID();
    const root = new ICAL.Component(['vcalendar', [], []]);
    root.updatePropertyWithValue('prodid', '-//Workspace Calendar//EN');
    root.updatePropertyWithValue('version', '2.0');
    const vevent = new ICAL.Component('vevent');
    vevent.updatePropertyWithValue('uid', uid);
    vevent.updatePropertyWithValue('summary', title);
    setTimes(vevent, time, false, this.zone);
    stamp(vevent);
    root.addSubcomponent(vevent);
    const ics = root.toString();
    const href = `${dav.url.replace(/\/?$/, '/')}${uid}.ics`;
    const etag = await this.options.client.put(href, ics, undefined);
    this.keep(dav, uid, { href, etag, ics });
    return { sourceId: uid, event: this.eventIn(dav, ics, `${dav.id}:${uid}`) };
  }

  /** Send `ics` as the new version of the object; on a 412, apply `redo` to the server's. */
  private async write(
    dav: CalDavCalendar,
    resourceId: string,
    object: StoredObject,
    ics: string,
    redo: (latest: string) => string,
    base: CalEvent | null,
  ): Promise<{ ics: string; conflict: CalEvent['conflict'] }> {
    try {
      const etag = await this.options.client.put(object.href, ics, object.etag);
      this.keep(dav, resourceId, { href: object.href, etag, ics });
      return { ics, conflict: null };
    } catch (error) {
      if (!(error instanceof CalDavError && error.code === 'precondition_failed')) throw error;
      const latest = await this.options.client.get(object.href);
      if (!latest) throw new CalDavError('not_found', 'The event is no longer on the server.', 404);
      const theirs = base && this.eventIn(dav, latest.ics, base.id);
      const next = redo(latest.ics);
      const etag = await this.options.client.put(object.href, next, latest.etag);
      this.keep(dav, resourceId, { href: object.href, etag, ics: next });
      return {
        ics: next,
        conflict: theirs && {
          title: theirs.title,
          allDay: theirs.allDay,
          start: theirs.start,
          end: theirs.end,
        },
      };
    }
  }

  async update(
    calendar: Calendar,
    sourceId: string,
    change: Change,
    { base, scope }: EditContext,
  ): Promise<UpdateResult> {
    const dav = calendar as CalDavCalendar;
    const series = base?.series;
    const resourceId = series?.id ?? sourceId;
    const object = this.stored(dav, resourceId);
    const floating = !!base?.floating;
    const zone = this.zone;

    if (series && scope === 'following') {
      const done = await this.updateFollowing(
        dav,
        resourceId,
        object,
        series.originalStart,
        change,
        base!,
      );
      if (done) return done;
    }
    const apply = (ics: string): string => {
      const { root, vevents, master } = partsOf(ics);
      if (series && scope === 'all' && master) {
        if (change.title !== undefined) master.updatePropertyWithValue('summary', change.title);
        if (change.time) this.shiftSeries(root, master, series.originalStart, change.time);
        stamp(master);
        return root.toString();
      }
      let target: ICAL.Component | undefined;
      if (series) {
        target = vevents.find((v) => keyOf(v) === series.originalStart);
        if (!target) {
          if (!master)
            throw new CalDavError('not_found', 'The event is no longer on the server.', 404);
          // A new exception: the series' details, for this occurrence.
          target = new ICAL.Component(ICAL.parse(master.toString()) as never);
          for (const name of ['rrule', 'rdate', 'exdate', 'exrule', 'dtstart', 'dtend', 'duration'])
            target.removeAllProperties(name);
          setTime(target, 'recurrence-id', timeForKey(series.originalStart));
          if (base)
            setTimes(
              target,
              { allDay: base.allDay, start: base.start, end: base.end, endSet: true },
              floating,
              zone,
            );
          root.addSubcomponent(target);
        }
      } else {
        target = master ?? vevents[0];
      }
      if (!target) throw new CalDavError('not_found', 'The event is no longer on the server.', 404);
      if (change.title !== undefined) target.updatePropertyWithValue('summary', change.title);
      if (change.time) setTimes(target, change.time, floating && !change.time.allDay, zone);
      stamp(target);
      return root.toString();
    };
    const written = await this.write(dav, resourceId, object, apply(object.ics), apply, base);
    this.options.rederive(dav);
    if (series && scope === 'all') return { series: true };
    const event = this.eventIn(dav, written.ics, base?.id ?? `${dav.id}:${sourceId}`);
    return event && { ...event, conflict: written.conflict };
  }

  /**
   * Where an occurrence started before it was moved, on this machine's clock (the event the
   * edit carries already shows the move: the outbox applied it here first).
   */
  private originalWall(key: string): string {
    return key.length === 10 || key.length === 16 ? key : wallAt(key, this.zone);
  }

  /** The series moved as much as its occurrence `key` was moved to `time`. */
  private shiftSeries(root: ICAL.Component, master: ICAL.Component, key: string, time: EventTime) {
    const start = master.getFirstPropertyValue('dtstart');
    if (!(start instanceof ICAL.Time)) return;
    const was = this.originalWall(key);
    const days = diffDays(was.slice(0, 10), time.start.slice(0, 10));
    const next = start.clone();
    if (start.isDate) next.adjust(days, 0, 0, 0);
    else
      next.adjust(
        0,
        0,
        was.length === 10 || time.allDay ? days * 1440 : diffMinutes(was, time.start),
        0,
      );
    const startProp = master.getFirstProperty('dtstart')!;
    startProp.setValue(next);
    master.removeAllProperties('duration');
    const end = next.clone();
    if (next.isDate) end.adjust(time.allDay ? diffDays(time.start, time.end) + 1 : 1, 0, 0, 0);
    else end.adjust(0, 0, time.allDay ? 60 : diffMinutes(time.start, time.end), 0);
    const tzid = startProp.getParameter('tzid');
    master.removeAllProperties('dtend');
    const endProp = new ICAL.Property('dtend', master);
    if (typeof tzid === 'string') endProp.setParameter('tzid', tzid);
    endProp.setValue(end);
    master.addProperty(endProp);
    for (const prop of master.getAllProperties('rrule')) {
      const recur = prop.getFirstValue();
      if (!(recur instanceof ICAL.Recur)) continue;
      const line = shiftWeekdays(`RRULE:${recur.toString()}`, days);
      prop.setValue(ICAL.Recur.fromString(line.slice(6)));
    }
    // The exceptions named the old occurrences: they no longer match.
    for (const vevent of root.getAllSubcomponents('vevent'))
      if (vevent.hasProperty('recurrence-id')) root.removeSubcomponent(vevent);
  }

  /**
   * "This and following": the series ends before the occurrence, and a new one starts there.
   * Null when the occurrence is the series' first (then it's "all events").
   */
  private async updateFollowing(
    dav: CalDavCalendar,
    resourceId: string,
    object: StoredObject,
    key: string,
    change: Change,
    base: CalEvent,
  ): Promise<UpdateResult | null> {
    const { master } = partsOf(object.ics);
    if (!master) return null;
    const first = timeOf(master.getFirstProperty('dtstart'));
    if (!first || occurrenceKey(first) === key) return null;

    // What's left of a COUNT goes on in the new series.
    const rrule = master.getFirstPropertyValue('rrule');
    let remaining: number | null = null;
    if (rrule instanceof ICAL.Recur && rrule.count) {
      const [item] = parseIcs(object.ics).items.filter((i) => !i.recurringEventId);
      const seriesZone = item?.start?.timeZone ?? this.zone;
      const allDay = !!item?.start?.date;
      const floatingStart = item?.start?.wall;
      const before = item?.start
        ? expand(
            {
              allDay,
              start: item.start.date ?? floatingStart ?? wallAt(item.start.dateTime!, seriesZone),
              timeZone: floatingStart ? this.zone : seriesZone,
              rules: item.recurrence ?? [],
            },
            '1970-01-01',
            key.length === 10 ? key : key.slice(0, 10),
          ).filter((o) => (key.length === 16 ? wallAt(o.start, this.zone) < key : o.start < key))
            .length
        : 0;
      remaining = Math.max(1, rrule.count - before);
    }

    const old = (ics: string) => {
      const { root, master: m } = partsOf(ics);
      if (m) {
        endBefore(root, m, key);
        stamp(m);
      }
      return root.toString();
    };
    await this.write(dav, resourceId, object, old(object.ics), old, base);

    const time: EventTime = change.time ?? {
      allDay: base.allDay,
      start: base.start,
      end: base.end,
      endSet: true,
    };
    const uid = randomUUID();
    const root = new ICAL.Component(['vcalendar', [], []]);
    root.updatePropertyWithValue('prodid', '-//Workspace Calendar//EN');
    root.updatePropertyWithValue('version', '2.0');
    const next = new ICAL.Component(ICAL.parse(master.toString()) as never);
    for (const name of ['rdate', 'exdate', 'exrule', 'recurrence-id', 'uid'])
      next.removeAllProperties(name);
    next.updatePropertyWithValue('uid', uid);
    if (change.title !== undefined) next.updatePropertyWithValue('summary', change.title);
    setTimes(next, time, !!base.floating && !time.allDay, this.zone);
    const days = diffDays(this.originalWall(key).slice(0, 10), time.start.slice(0, 10));
    for (const prop of next.getAllProperties('rrule')) {
      const recur = prop.getFirstValue() as ICAL.Recur;
      let line = shiftWeekdays(`RRULE:${recur.toString()}`, days).slice(6);
      if (remaining !== null) line = line.replace(/COUNT=\d+/i, `COUNT=${remaining}`);
      prop.setValue(ICAL.Recur.fromString(line));
    }
    stamp(next);
    root.addSubcomponent(next);
    const ics = root.toString();
    const href = `${dav.url.replace(/\/?$/, '/')}${uid}.ics`;
    const etag = await this.options.client.put(href, ics, undefined);
    this.keep(dav, uid, { href, etag, ics });
    this.options.rederive(dav);
    return { series: true };
  }

  async trash(calendar: Calendar, sourceId: string, { base, scope }: EditContext) {
    const dav = calendar as CalDavCalendar;
    const series = base?.series;
    const resourceId = series?.id ?? sourceId;
    let object: StoredObject;
    try {
      object = this.stored(dav, resourceId);
    } catch {
      return; // Already gone.
    }
    const removeAll = async () => {
      try {
        await this.options.client.delete(object.href, object.etag);
      } catch (error) {
        if (!(error instanceof CalDavError && error.code === 'precondition_failed')) throw error;
        await this.options.client.delete(object.href, null); // Changed meanwhile: last write wins.
      }
      this.options.cache.removeItem(dav.id, resourceId);
    };
    if (!series || scope === 'all') {
      await removeAll();
      this.options.rederive(dav);
      return;
    }
    const key = series.originalStart;
    const { master } = partsOf(object.ics);
    const first = master && timeOf(master.getFirstProperty('dtstart'));
    if (scope === 'following' && first && occurrenceKey(first) === key) {
      await removeAll();
      this.options.rederive(dav);
      return;
    }
    const apply = (ics: string) => {
      const { root, master: m } = partsOf(ics);
      if (scope === 'following' && m) endBefore(root, m, key);
      else {
        for (const vevent of root.getAllSubcomponents('vevent'))
          if (keyOf(vevent) === key) root.removeSubcomponent(vevent);
        if (m) {
          const exdate = new ICAL.Property('exdate', m);
          exdate.setValue(timeForKey(key));
          // The same kind of value as the series' start (a zone's time is written in UTC).
          m.addProperty(exdate);
          stamp(m);
        }
      }
      return root.toString();
    };
    await this.write(dav, resourceId, object, apply(object.ics), apply, base);
    this.options.rederive(dav);
  }
}
