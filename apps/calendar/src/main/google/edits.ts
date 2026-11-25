/**
 * Edits made here, sent to Google (HANDOFF.md 4, "Editing"), for the outbox:
 * - create (`insert`), change (`patch`, with `If-Match: etag`), delete;
 * - an event changed in Google since it was read (`412`) is read again, kept as "Changed
 *   elsewhere", and the edit sent anyway: the last write wins, as for Workspace;
 * - a recurring event's occurrence changes as the person chose:
 *   - **This event:** the occurrence alone (Google makes it an exception);
 *   - **All events:** the series, shifted by as much as the occurrence moved;
 *   - **This and following:** the series ends before the occurrence (`UNTIL`), and a new series
 *     starts with the change.
 */
import { addDays, addMinutes, diffDays, diffMinutes, type EventTime } from '../../shared/dates';
import { eventFromGoogle, googleTimes, occurrenceKey, type GoogleEvent } from '../../shared/google';
import { expand } from '../../shared/recurrence';
import type { CalEvent, Calendar, EditScope, GoogleCalendar } from '../../shared/types';
import { basicUtc, instantAt, wallAt } from '../../shared/zones';
import type { EditContext, EditTarget, UpdateResult } from '../outbox';
import { GoogleApiError, type GoogleEngine } from './client';

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A rule's BYDAY moved by whole days (a weekly Monday series moved to Tuesday). */
function shiftWeekdays(rule: string, days: number): string {
  const shift = ((days % 7) + 7) % 7;
  if (!shift) return rule;
  return rule.replace(
    /BYDAY=([^;]+)/i,
    (_m, list: string) =>
      `BYDAY=${list
        .split(',')
        .map((token) => {
          const m = /^([+-]?\d*)([A-Z]{2})$/i.exec(token.trim());
          if (!m) return token;
          const i = DAYS.indexOf(m[2]!.toUpperCase());
          return i < 0 ? token : `${m[1]}${DAYS[(i + shift) % 7]}`;
        })
        .join(',')}`,
  );
}

const isRule = (line: string) => /^RRULE[:;]/i.test(line);

/** Rules ending just before `key` (an occurrence's start: a day, or UTC). */
function endedBefore(rules: string[], key: string): string[] {
  const until =
    key.length === 10
      ? addDays(key, -1).replace(/-/g, '')
      : basicUtc(new Date(Date.parse(key) - 1000));
  return rules.map((line) =>
    isRule(line)
      ? `${line.replace(/;?(COUNT|UNTIL)=[^;]*/gi, '').replace(/:;/, ':')};UNTIL=${until}`
      : line,
  );
}

/** A changed event: its fields from the change and what it was. */
function bodyOf(
  change: { title?: string; time?: EventTime },
  zone: string,
  eventZone: string,
): Partial<GoogleEvent> {
  return {
    ...(change.title !== undefined && { summary: change.title }),
    ...(change.time && googleTimes(change.time, zone, eventZone)),
  };
}

export class GoogleEditTarget implements EditTarget {
  constructor(
    private readonly engine: GoogleEngine,
    private readonly zone: () => string,
  ) {}

  async create(calendar: Calendar, title: string, time: EventTime) {
    const g = calendar as GoogleCalendar;
    const item = await this.engine.insert(g.googleId, {
      summary: title,
      ...googleTimes(time, this.zone(), g.timeZone),
    });
    return { sourceId: item.id, event: eventFromGoogle(g, item, this.zone()) };
  }

  async update(
    calendar: Calendar,
    sourceId: string,
    change: { title?: string; time?: EventTime },
    { base, scope }: EditContext,
  ): Promise<UpdateResult> {
    const g = calendar as GoogleCalendar;
    const series = base?.series;
    if (series && scope === 'all') return this.updateAll(g, series, change, base);
    if (series && scope === 'following') return this.updateFollowing(g, series, change, base);
    const zone = this.zone();
    const body = bodyOf(change, zone, base?.timeZone ?? g.timeZone);
    let conflict: CalEvent['conflict'] = null;
    let item: GoogleEvent;
    try {
      item = await this.engine.patch(g.googleId, sourceId, body, base?.etag);
    } catch (e) {
      if (!(e instanceof GoogleApiError && e.code === 'precondition_failed')) throw e;
      // Changed in Google meanwhile: keep its version to show, and send the edit anyway.
      const current = eventFromGoogle(g, await this.engine.get(g.googleId, sourceId), zone);
      if (current)
        conflict = {
          title: current.title,
          allDay: current.allDay,
          start: current.start,
          end: current.end,
        };
      item = await this.engine.patch(g.googleId, sourceId, body);
    }
    const event = eventFromGoogle(g, item, zone);
    return event && { ...event, conflict };
  }

  /** The whole series: its title, and its times moved as much as the occurrence was. */
  private async updateAll(
    g: GoogleCalendar,
    series: NonNullable<CalEvent['series']>,
    change: { title?: string; time?: EventTime },
    base: CalEvent,
  ): Promise<UpdateResult> {
    const master = await this.engine.get(g.googleId, series.id);
    const body: Partial<GoogleEvent> = {
      ...(change.title !== undefined && { summary: change.title }),
      ...(change.time && this.shifted(master, series.originalStart, change.time, base)),
    };
    await this.engine.patch(g.googleId, series.id, body);
    return { series: true };
  }

  /**
   * The series' start, end and rules moved as the occurrence (that started at `originalStart`)
   * was moved to `time`, on the series' own clock.
   */
  private shifted(
    master: GoogleEvent,
    originalStart: string,
    time: EventTime,
    base: CalEvent,
  ): Partial<GoogleEvent> {
    const zone = this.zone();
    if (master.start?.date) {
      const days = diffDays(originalStart.slice(0, 10), time.start.slice(0, 10));
      const start = addDays(master.start.date, days);
      const length = time.allDay ? diffDays(time.start, time.end) : 0;
      return {
        start: { date: start },
        end: { date: addDays(start, length + 1) },
        recurrence: master.recurrence?.map((r) => (isRule(r) ? shiftWeekdays(r, days) : r)),
      };
    }
    const seriesZone = master.start?.timeZone ?? base.timeZone ?? zone;
    const wasWall = wallAt(originalStart, seriesZone);
    const nowWall = wallAt(instantAt(time.start, zone), seriesZone);
    const minutes = diffMinutes(wasWall, nowWall);
    const startWall = addMinutes(wallAt(master.start!.dateTime!, seriesZone), minutes);
    const length = diffMinutes(time.start, time.end);
    const days = diffDays(wasWall.slice(0, 10), nowWall.slice(0, 10));
    return {
      start: { dateTime: instantAt(startWall, seriesZone).toISOString(), timeZone: seriesZone },
      end: {
        dateTime: instantAt(addMinutes(startWall, length), seriesZone).toISOString(),
        timeZone: seriesZone,
      },
      recurrence: master.recurrence?.map((r) => (isRule(r) ? shiftWeekdays(r, days) : r)),
    };
  }

  /** The series ends before this occurrence; a new one starts from it, changed. */
  private async updateFollowing(
    g: GoogleCalendar,
    series: NonNullable<CalEvent['series']>,
    change: { title?: string; time?: EventTime },
    base: CalEvent,
  ): Promise<UpdateResult> {
    const master = await this.engine.get(g.googleId, series.id);
    const first = master.start && occurrenceKey(master.start);
    if (first === series.originalStart) return this.updateAll(g, series, change, base);
    const rules = master.recurrence ?? [];
    // A COUNT goes on in the new series: what's left of it.
    const count = /COUNT=(\d+)/i.exec(rules.find(isRule) ?? '')?.[1];
    let remaining: number | null = null;
    if (count) {
      const seriesZone = master.start?.timeZone ?? g.timeZone;
      const before = expand(
        {
          allDay: !!master.start?.date,
          start: master.start?.date ?? wallAt(master.start!.dateTime!, seriesZone),
          timeZone: seriesZone,
          rules,
        },
        '1970-01-01',
        series.originalStart.length === 10
          ? addDays(series.originalStart, -1)
          : wallAt(series.originalStart, seriesZone).slice(0, 10),
      ).filter((o) => o.start < series.originalStart).length;
      remaining = Math.max(1, Number(count) - before);
    }
    await this.engine.patch(g.googleId, series.id, {
      recurrence: endedBefore(rules, series.originalStart),
    });
    const time: EventTime = change.time ?? {
      allDay: base.allDay,
      start: base.start,
      end: base.end,
      endSet: true,
    };
    const days = diffDays(base.start.slice(0, 10), time.start.slice(0, 10));
    const nextRules = rules.map((r) => {
      if (!isRule(r)) return r;
      const shifted = shiftWeekdays(r, days);
      return remaining === null ? shifted : shifted.replace(/COUNT=\d+/i, `COUNT=${remaining}`);
    });
    await this.engine.insert(g.googleId, {
      summary: change.title ?? master.summary ?? '',
      ...(master.description && { description: master.description }),
      ...(master.location && { location: master.location }),
      ...googleTimes(time, this.zone(), master.start?.timeZone ?? g.timeZone),
      recurrence: nextRules,
    });
    return { series: true };
  }

  async trash(calendar: Calendar, sourceId: string, { base, scope }: EditContext) {
    const g = calendar as GoogleCalendar;
    const series = base?.series;
    if (series && scope === 'all') return this.engine.remove(g.googleId, series.id);
    if (series && scope === 'following') {
      const master = await this.engine.get(g.googleId, series.id);
      if (master.start && occurrenceKey(master.start) === series.originalStart)
        return this.engine.remove(g.googleId, series.id);
      await this.engine.patch(g.googleId, series.id, {
        recurrence: endedBefore(master.recurrence ?? [], series.originalStart),
      });
      return;
    }
    await this.engine.remove(g.googleId, sourceId);
  }
}

export type { EditScope };
