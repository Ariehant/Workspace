/**
 * CalDAV against a real server (Radicale, test/radicale.ts): connecting and choosing calendars,
 * reading changes with sync tokens, edits round-tripping (create, move, rename, delete, a
 * change made elsewhere meanwhile), and recurring events' "this", "following" and "all".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, today, type EventTime } from '../src/shared/dates';
import type { CalEvent } from '../src/shared/types';
import { instantAt } from '../src/shared/zones';
import { Cache } from '../src/main/cache';
import { CalendarService } from '../src/main/service';
import { startRadicale, type Radicale } from './radicale';

const ZONE = 'Asia/Kolkata';
let radicale: Radicale;
beforeAll(async () => {
  radicale = await startRadicale();
}, 30_000);
afterAll(() => radicale?.stop());

const d = (offset: number) => addDays(today(), offset);
/** A UTC iCalendar time for a Kolkata wall time on day `offset`. */
const utc = (offset: number, hhmm: string) =>
  instantAt(`${d(offset)}T${hhmm}`, ZONE)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
const timed = (offset: number, from: string, to: string): EventTime => ({
  allDay: false,
  start: `${d(offset)}T${from}`,
  end: `${d(offset)}T${to}`,
  endSet: true,
});
const vevent = (uid: string, lines: string[]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Another client//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261101T000000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

let n = 0;
let calendarUrl: string;
let cache: Cache;
let service: CalendarService;

beforeEach(async () => {
  calendarUrl = await radicale.makeCalendar(`Work ${++n}`, {
    colour: '#7BD148FF',
    id: `work-${n}`,
  });
  cache = new Cache(':memory:');
  service = new CalendarService({
    cache,
    seal: (t) => t,
    unseal: (s) => s,
    secureStorage: () => true,
    zone: () => ZONE,
  });
});

async function connect() {
  const session = await service.caldavConnect(radicale.url, radicale.username, radicale.password);
  const mine = session.calendars.find((c) => c.url.endsWith(`/work-${n}/`))!;
  await service.caldavSave(session.sessionId, [mine.url]);
  return cache.calendars().find((c) => c.kind === 'caldav' && c.url.endsWith(`/work-${n}/`))!;
}

const shown = () =>
  service
    .events(d(-2), d(40))
    .map((e) => `${e.title} ${e.start}`)
    .sort();
const find = (title: string): CalEvent =>
  service.events(d(-2), d(40)).find((e) => e.title === title)!;
/** Send what's waiting now (deletes skip their Undo wait), then read the server again. */
async function settle() {
  for (const op of cache.ops()) cache.updateOp({ ...op, notBefore: 0 });
  await service.outbox.flush();
  await service.sync.syncAll();
}
const objects = async () => {
  const res = await fetch(calendarUrl, {
    method: 'PROPFIND',
    headers: {
      authorization: `Basic ${Buffer.from(`${radicale.username}:${radicale.password}`).toString('base64')}`,
      depth: '1',
    },
  });
  return [...(await res.text()).matchAll(/<href>([^<]+\.ics)<\/href>/g)].map((m) => m[1]!);
};

describe('connecting', () => {
  it('lists the calendars with their names and colours, and adds the chosen ones', async () => {
    const session = await service.caldavConnect(radicale.url, radicale.username, radicale.password);
    expect(session.name).toBe(`ada · ${new URL(radicale.url).host}`);
    expect(session.calendars).toContainEqual({
      url: expect.stringMatching(new RegExp(`/work-${n}/$`)),
      name: `Work ${n}`,
      colour: '#7bd148',
      added: false,
    });
    const calendar = await connect();
    expect(calendar).toMatchObject({ name: `Work ${n}`, colour: '#7bd148', accessRole: 'owner' });
    expect(cache.accounts()).toEqual([
      expect.objectContaining({ kind: 'caldav', username: 'ada', server: radicale.url }),
    ]);
  });

  it("refuses a wrong password, and a server that isn't CalDAV", async () => {
    await expect(service.caldavConnect(radicale.url, radicale.username, 'wrong')).rejects.toThrow(
      /username or app password/,
    );
    await expect(service.caldavConnect('http://example.com', 'a', 'b')).rejects.toThrow(
      /https:\/\//,
    );
  });
});

describe('reading', () => {
  it('reads events and series, then only what changed', async () => {
    await radicale.put(
      calendarUrl,
      'a.ics',
      vevent('a', ['SUMMARY:Planning', `DTSTART:${utc(1, '10:00')}`, `DTEND:${utc(1, '11:00')}`]),
    );
    await radicale.put(
      calendarUrl,
      'standup.ics',
      vevent('standup', [
        'SUMMARY:Standup',
        'DTSTART;TZID=Asia/Kolkata:' + d(2).replace(/-/g, '') + 'T090000',
        'DTEND;TZID=Asia/Kolkata:' + d(2).replace(/-/g, '') + 'T091500',
        'RRULE:FREQ=DAILY;COUNT=3',
      ]),
    );
    await connect();
    expect(shown()).toEqual([
      `Planning ${d(1)}T10:00`,
      `Standup ${d(2)}T09:00`,
      `Standup ${d(3)}T09:00`,
      `Standup ${d(4)}T09:00`,
    ]);

    // Changed elsewhere: renamed, one deleted, one new.
    await radicale.put(
      calendarUrl,
      'a.ics',
      vevent('a', [
        'SUMMARY:Planning (moved)',
        `DTSTART:${utc(5, '10:00')}`,
        `DTEND:${utc(5, '11:00')}`,
      ]),
    );
    await radicale.remove(`${calendarUrl}standup.ics`);
    await radicale.put(
      calendarUrl,
      'b.ics',
      vevent('b@other.example', [
        'SUMMARY:Lunch',
        `DTSTART:${utc(1, '13:00')}`,
        `DTEND:${utc(1, '14:00')}`,
      ]),
    );
    await service.sync.syncAll();
    expect(shown()).toEqual([`Lunch ${d(1)}T13:00`, `Planning (moved) ${d(5)}T10:00`]);
  });
});

describe('editing', () => {
  it('creates, moves, renames and deletes, and the server has each change', async () => {
    const calendar = await connect();
    service.createEvent(calendar.id, 'Review', timed(1, '10:00', '11:00'));
    await settle();
    const [href] = await objects();
    expect(href).toBeDefined();
    const created = await radicale.get(`${radicale.url}${href}`);
    expect(created!.ics).toContain('SUMMARY:Review');
    expect(created!.ics).toContain(`DTSTART:${utc(1, '10:00')}`);
    expect(shown()).toEqual([`Review ${d(1)}T10:00`]);

    service.updateEvent(find('Review').id, {
      title: 'Review (moved)',
      time: timed(3, '15:00', '16:30'),
    });
    await settle();
    const moved = await radicale.get(`${radicale.url}${href}`);
    expect(moved!.ics).toContain('SUMMARY:Review (moved)');
    expect(moved!.ics).toContain(`DTEND:${utc(3, '16:30')}`);
    expect(shown()).toEqual([`Review (moved) ${d(3)}T15:00`]);

    service.deleteEvent(find('Review (moved)').id);
    await settle();
    expect(await objects()).toEqual([]);
    expect(shown()).toEqual([]);
  });

  it('keeps the other version as "changed elsewhere" when the event changed meanwhile', async () => {
    await radicale.put(
      calendarUrl,
      'c.ics',
      vevent('c', [
        'SUMMARY:Call',
        `DTSTART:${utc(1, '09:00')}`,
        `DTEND:${utc(1, '10:00')}`,
        'LOCATION:Room 4',
      ]),
    );
    await connect();
    // Someone moves it elsewhere; this calendar hasn't read that yet.
    await radicale.put(
      calendarUrl,
      'c.ics',
      vevent('c', [
        'SUMMARY:Call',
        `DTSTART:${utc(1, '12:00')}`,
        `DTEND:${utc(1, '13:00')}`,
        'LOCATION:Room 4',
      ]),
    );
    service.updateEvent(find('Call').id, { title: 'Call with Bea' });
    await service.outbox.flush();
    const now = await radicale.get(`${calendarUrl}c.ics`);
    // The rename went onto their version (moved to 12:00), keeping what the calendar doesn't edit.
    expect(now!.ics).toContain('SUMMARY:Call with Bea');
    expect(now!.ics).toContain(`DTSTART:${utc(1, '12:00')}`);
    expect(now!.ics).toContain('LOCATION:Room 4');
    expect(find('Call with Bea').conflict).toMatchObject({ title: 'Call', start: `${d(1)}T12:00` });
  });
});

describe('editing recurring events', () => {
  const series = (count = 4) =>
    vevent('standup', [
      'SUMMARY:Standup',
      `DTSTART:${utc(1, '09:00')}`,
      `DTEND:${utc(1, '09:15')}`,
      `RRULE:FREQ=DAILY;COUNT=${count}`,
    ]);
  const occurrence = (offset: number) =>
    service
      .events(d(-2), d(40))
      .find((e) => e.series?.id === 'standup' && e.start.startsWith(d(offset)))!;

  it('changes this event only (an exception in the same object)', async () => {
    await radicale.put(calendarUrl, 'standup.ics', series());
    await connect();
    service.updateEvent(
      occurrence(2).id,
      { title: 'Standup (late)', time: timed(2, '11:00', '11:15') },
      'this',
    );
    await settle();
    expect(shown()).toEqual([
      `Standup (late) ${d(2)}T11:00`,
      `Standup ${d(1)}T09:00`,
      `Standup ${d(3)}T09:00`,
      `Standup ${d(4)}T09:00`,
    ]);
    const stored = await radicale.get(`${calendarUrl}standup.ics`);
    expect(stored!.ics).toContain(`RECURRENCE-ID:${utc(2, '09:00')}`);
    expect(await objects()).toHaveLength(1);
  });

  it('moves all events as much as the one dragged', async () => {
    await radicale.put(calendarUrl, 'standup.ics', series());
    await connect();
    service.updateEvent(occurrence(3).id, { time: timed(3, '09:30', '10:00') }, 'all');
    await settle();
    expect(shown()).toEqual([1, 2, 3, 4].map((i) => `Standup ${d(i)}T09:30`));
  });

  it('changes this and following: the series ends, a new object goes on with the rest of COUNT', async () => {
    await radicale.put(calendarUrl, 'standup.ics', series(4));
    await connect();
    service.updateEvent(
      occurrence(3).id,
      { title: 'Standup v2', time: timed(3, '10:00', '10:15') },
      'following',
    );
    await settle();
    expect(shown()).toEqual([
      `Standup ${d(1)}T09:00`,
      `Standup ${d(2)}T09:00`,
      `Standup v2 ${d(3)}T10:00`,
      `Standup v2 ${d(4)}T10:00`,
    ]);
    expect(await objects()).toHaveLength(2);
    expect((await radicale.get(`${calendarUrl}standup.ics`))!.ics).toMatch(
      /RRULE:FREQ=DAILY;UNTIL=\d{8}T\d{6}Z/,
    );
  });

  it('deletes this event (an EXDATE), the following ones, or all', async () => {
    await radicale.put(calendarUrl, 'standup.ics', series(5));
    await connect();
    service.deleteEvent(occurrence(2).id, 'this');
    await settle();
    expect(shown()).toHaveLength(4);
    expect((await radicale.get(`${calendarUrl}standup.ics`))!.ics).toContain(
      `EXDATE:${utc(2, '09:00')}`,
    );

    service.deleteEvent(occurrence(4).id, 'following');
    await settle();
    expect(shown()).toEqual([`Standup ${d(1)}T09:00`, `Standup ${d(3)}T09:00`]);

    service.deleteEvent(occurrence(1).id, 'all');
    await settle();
    expect(await objects()).toEqual([]);
    expect(shown()).toEqual([]);
  });
});
