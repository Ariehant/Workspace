/**
 * Editing Google events through the service and its outbox, against the fake Google: create,
 * move, rename, delete, a change made in Google meanwhile (`412`), and recurring events'
 * "this event", "all events" and "this and following".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, today, type EventTime } from '../src/shared/dates';
import type { GoogleEvent } from '../src/shared/google';
import type { CalEvent } from '../src/shared/types';
import { instantAt } from '../src/shared/zones';
import { Cache } from '../src/main/cache';
import { CalendarService } from '../src/main/service';
import { googleEnv, startFakeGoogle, type FakeGoogle } from './fake-google';

const ZONE = 'Asia/Kolkata';
let fake: FakeGoogle;
const d = (offset: number) => addDays(today(), offset);
const at = (offset: number, hhmm: string) => ({
  dateTime: instantAt(`${d(offset)}T${hhmm}`, ZONE).toISOString(),
  timeZone: ZONE,
});
const timed = (offset: number, from: string, to: string): EventTime => ({
  allDay: false,
  start: `${d(offset)}T${from}`,
  end: `${d(offset)}T${to}`,
  endSet: true,
});

beforeAll(async () => {
  fake = await startFakeGoogle();
});
afterAll(() => fake?.close());

let n = 0;
let googleId: string;
let cache: Cache;
let service: CalendarService;

beforeEach(async () => {
  googleId = `edits${++n}@lab.io`;
  fake.addCalendar({
    id: googleId,
    summary: `Edits ${n}`,
    accessRole: 'owner',
    timeZone: ZONE,
    primary: true,
  });
  cache = new Cache(':memory:');
  service = new CalendarService({
    cache,
    seal: (t) => t,
    unseal: (s) => s,
    secureStorage: () => true,
    openBrowser: async (url) => {
      await fetch(url);
    },
    env: googleEnv(fake),
    zone: () => ZONE,
    clientOptions: { sleep: async () => {} },
  });
  const connect = await service.googleSignIn();
  await service.googleSave(connect.sessionId, [googleId]);
});

const calendarId = () =>
  cache.calendars().find((c) => c.kind === 'google' && c.googleId === googleId)!.id;
const shown = () =>
  service
    .events(d(-2), d(30))
    .filter((e) => e.calendarId === calendarId())
    .map((e) => `${e.title} ${e.start}`)
    .sort();
const inGoogle = (id: string) => fake.calendars.get(googleId)!.events.get(id)?.event;
/** Send what's waiting now (deletes wait for Undo: not here), then read Google again. */
async function settle() {
  for (const op of cache.ops()) cache.updateOp({ ...op, notBefore: 0 });
  await service.outbox.flush();
  await service.sync.syncAll();
}
const find = (title: string): CalEvent =>
  service.events(d(-2), d(30)).find((e) => e.title === title)!;

describe('editing Google events', () => {
  it("creates an event at the instant shown, in the calendar's zone", async () => {
    service.createEvent(calendarId(), 'Planning', timed(1, '10:00', '11:00'));
    await settle();
    const made = [...fake.calendars.get(googleId)!.events.values()].map((s) => s.event);
    expect(made).toEqual([
      expect.objectContaining({
        summary: 'Planning',
        start: { dateTime: instantAt(`${d(1)}T10:00`, ZONE).toISOString(), timeZone: ZONE },
      }),
    ]);
    expect(shown()).toEqual([`Planning ${d(1)}T10:00`]);
    expect(find('Planning').sourceId).toBe(made[0]!.id);
  });

  it("creates all-day events with Google's exclusive end", async () => {
    service.createEvent(calendarId(), 'Trip', {
      allDay: true,
      start: d(3),
      end: d(5),
      endSet: true,
    });
    await settle();
    const [trip] = [...fake.calendars.get(googleId)!.events.values()].map((s) => s.event);
    expect(trip).toMatchObject({ start: { date: d(3) }, end: { date: d(6) } });
    expect(find('Trip')).toMatchObject({ start: d(3), end: d(5) });
  });

  it('moves and renames with the etag, and deletes', async () => {
    fake.put(googleId, { id: 'm', summary: 'Meeting', start: at(1, '09:00'), end: at(1, '10:00') });
    await service.sync.syncAll();
    const etag = inGoogle('m')!.etag;
    service.updateEvent(find('Meeting').id, {
      title: 'Meeting (moved)',
      time: timed(2, '15:00', '16:30'),
    });
    await settle();
    expect(fake.requests.find((r) => r.startsWith('PATCH'))).toBeDefined();
    expect(inGoogle('m')).toMatchObject({
      summary: 'Meeting (moved)',
      start: at(2, '15:00'),
      end: at(2, '16:30'),
    });
    expect(inGoogle('m')!.etag).not.toBe(etag);
    expect(shown()).toEqual([`Meeting (moved) ${d(2)}T15:00`]);

    service.deleteEvent(find('Meeting (moved)').id);
    expect(shown()).toEqual([]);
    await settle();
    expect(inGoogle('m')!.status).toBe('cancelled');
    expect(shown()).toEqual([]);
  });

  it('keeps Google\'s version as "changed elsewhere" when the event changed meanwhile (412)', async () => {
    fake.put(googleId, { id: 'c', summary: 'Call', start: at(1, '09:00'), end: at(1, '10:00') });
    await service.sync.syncAll();
    // Someone moves it in Google; the calendar hasn't read that yet.
    fake.put(googleId, { id: 'c', summary: 'Call', start: at(1, '12:00'), end: at(1, '13:00') });
    service.updateEvent(find('Call').id, { title: 'Call with Bea' });
    await service.outbox.flush();
    // The edit still went (last write wins), and the event shows what Google had.
    expect(inGoogle('c')).toMatchObject({ summary: 'Call with Bea', start: at(1, '12:00') });
    expect(find('Call with Bea').conflict).toMatchObject({ title: 'Call', start: `${d(1)}T12:00` });
  });

  it('refuses edits to a calendar the account may only see', async () => {
    fake.addCalendar({
      id: `ro${n}@lab.io`,
      summary: 'View only',
      accessRole: 'reader',
      timeZone: ZONE,
    });
    fake.put(`ro${n}@lab.io`, {
      id: 'r',
      summary: 'Theirs',
      start: at(1, '09:00'),
      end: at(1, '10:00'),
    });
    const again = await service.googleSignIn();
    await service.googleSave(again.sessionId, [`ro${n}@lab.io`]);
    const theirs = find('Theirs');
    expect(() => service.updateEvent(theirs.id, { title: 'Mine now' })).toThrow(/view-only/);
    const readOnly = cache.calendars().find((c) => c.name === 'View only')!;
    expect(() => service.createEvent(readOnly.id, 'X', timed(1, '09:00', '10:00'))).toThrow(
      /view-only/,
    );
  });
});

describe('editing recurring Google events', () => {
  const standup = (count = 4): Omit<GoogleEvent, 'etag' | 'updated'> => ({
    id: 'standup',
    summary: 'Standup',
    start: at(1, '09:00'),
    end: at(1, '09:15'),
    recurrence: [`RRULE:FREQ=DAILY;COUNT=${count}`],
  });
  const occurrence = (offset: number) =>
    service
      .events(d(-2), d(30))
      .find((e) => e.series?.id === 'standup' && e.start.startsWith(d(offset)))!;

  it('changes this event only', async () => {
    fake.put(googleId, standup());
    await service.sync.syncAll();
    service.updateEvent(occurrence(2).id, { time: timed(2, '11:00', '11:15') }, 'this');
    await settle();
    expect(shown()).toEqual([
      `Standup ${d(1)}T09:00`,
      `Standup ${d(2)}T11:00`,
      `Standup ${d(3)}T09:00`,
      `Standup ${d(4)}T09:00`,
    ]);
    expect(inGoogle('standup')!.start).toEqual(at(1, '09:00'));
  });

  it('moves all events as much as the one dragged', async () => {
    fake.put(googleId, standup());
    await service.sync.syncAll();
    service.updateEvent(
      occurrence(3).id,
      { title: 'Daily', time: timed(3, '09:30', '10:00') },
      'all',
    );
    await settle();
    expect(inGoogle('standup')).toMatchObject({
      summary: 'Daily',
      start: at(1, '09:30'),
      end: at(1, '10:00'),
    });
    expect(shown()).toEqual([1, 2, 3, 4].map((i) => `Daily ${d(i)}T09:30`));
  });

  it('moves a weekly series to another day', async () => {
    fake.put(googleId, {
      id: 'standup',
      summary: 'Weekly',
      start: at(1, '09:00'),
      end: at(1, '10:00'),
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=2'],
    });
    await service.sync.syncAll();
    service.updateEvent(occurrence(1).id, { time: timed(2, '09:00', '10:00') }, 'all');
    await settle();
    expect(shown()).toEqual([`Weekly ${d(2)}T09:00`, `Weekly ${d(9)}T09:00`]);
  });

  it('changes this and following events: the series ends, a new one goes on', async () => {
    fake.put(googleId, standup(4));
    await service.sync.syncAll();
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
    expect(inGoogle('standup')!.recurrence).toEqual([
      expect.stringMatching(/^RRULE:FREQ=DAILY;UNTIL=\d{8}T\d{6}Z$/),
    ]);
  });

  it('deletes this event, the following ones, or all, with Undo for all of them', async () => {
    fake.put(googleId, standup(5));
    await service.sync.syncAll();

    service.deleteEvent(occurrence(2).id, 'this');
    await settle();
    expect(shown()).toHaveLength(4);

    service.deleteEvent(occurrence(4).id, 'following');
    expect(shown()).toEqual([`Standup ${d(1)}T09:00`, `Standup ${d(3)}T09:00`]);
    await settle();
    expect(shown()).toEqual([`Standup ${d(1)}T09:00`, `Standup ${d(3)}T09:00`]);

    const first = occurrence(1);
    service.deleteEvent(first.id, 'all');
    expect(shown()).toEqual([]);
    service.undoDelete(first.id);
    expect(shown()).toEqual([`Standup ${d(1)}T09:00`, `Standup ${d(3)}T09:00`]);
    service.deleteEvent(first.id, 'all');
    await settle();
    expect(inGoogle('standup')!.status).toBe('cancelled');
    expect(shown()).toEqual([]);
  });
});
