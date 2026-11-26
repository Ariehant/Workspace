/**
 * Subscribing to iCalendar feeds through the service, against a fake feed server: the first
 * read, refreshes that only ask for changes (`304`), redirects, a feed that went away, one that
 * isn't a calendar, and `webcal://`.
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays, today } from '../src/shared/dates';
import { Cache } from '../src/main/cache';
import { feedUrl, IcsCalendarSync, REFRESH_EVERY_MS } from '../src/main/ics/sync';
import { CalendarService } from '../src/main/service';
import { feedWith, startFakeFeeds, type FakeFeeds } from './fake-ics';

let feeds: FakeFeeds;
beforeAll(async () => {
  feeds = await startFakeFeeds();
});
afterAll(() => feeds?.close());

const d = (offset: number) => addDays(today(), offset);
let cache: Cache;
let service: CalendarService;

beforeEach(() => {
  feeds.feeds.clear();
  feeds.redirects.clear();
  feeds.failures.clear();
  feeds.requests.length = 0;
  cache = new Cache(':memory:');
  service = new CalendarService({
    cache,
    seal: (t) => t,
    unseal: (s) => s,
    secureStorage: () => true,
    zone: () => 'Asia/Kolkata',
  });
});

const titles = () =>
  service
    .events(d(-200), d(400))
    .map((e) => e.title)
    .sort();

describe('subscribing to feeds', () => {
  it('reads a holiday feed, named and zoned by the feed, without reminders', async () => {
    feeds.feeds.set(
      '/holidays.ics',
      readFileSync(new URL('./fixtures/ics/holidays.ics', import.meta.url), 'utf8'),
    );
    const calendar = await service.subscribe(`${feeds.origin}/holidays.ics`);
    expect(calendar).toMatchObject({
      kind: 'ics',
      name: 'Holidays in India',
      timeZone: 'Asia/Kolkata',
      accessRole: 'reader',
      reminder: null,
      status: 'ok',
    });
    expect(cache.accounts()).toEqual([
      expect.objectContaining({ kind: 'ics', name: 'Subscriptions' }),
    ]);
    // The fixtures are 2026–2027: the window keeps 6 months back and 12 ahead.
    expect(
      service
        .events('2026-01-01', '2027-12-31')
        .some((e) => e.title === 'Diwali/Deepavali' && e.allDay),
    ).toBe(true);
    // Read-only.
    const event = service.events('2026-01-01', '2027-12-31')[0]!;
    expect(() => service.deleteEvent(event.id)).toThrow(/view-only|can’t/i);
    // A second feed goes under the same account; the same feed twice is refused.
    feeds.feeds.set(
      '/team.ics',
      feedWith([{ uid: 't1', summary: 'Team day', start: d(3) }], 'Team'),
    );
    await service.subscribe(`${feeds.origin}/team.ics`, 'Our team');
    expect(cache.accounts()).toHaveLength(1);
    expect(cache.calendars().map((c) => c.name)).toEqual(['Holidays in India', 'Our team']);
    await expect(service.subscribe(`${feeds.origin}/team.ics`)).rejects.toThrow(
      /already subscribed/,
    );
  });

  it('refreshes every 30 minutes and on Sync now, asking only for changes', async () => {
    let now = Date.now();
    const sync = new IcsCalendarSync({ cache, now: () => now, zone: () => 'Asia/Kolkata' });
    feeds.feeds.set('/f.ics', feedWith([{ uid: 'a', summary: 'First', start: d(1) }]));
    const calendar = await service.subscribe(`${feeds.origin}/f.ics`);
    expect(titles()).toEqual(['First']);
    // The clock starts when the feed was read.
    now = Date.now();
    const before = feeds.requests.length;

    // Within 30 minutes: not asked again.
    await sync.sync(calendar as never, false);
    expect(feeds.requests.length).toBe(before);

    // After 30 minutes, unchanged: a 304, and nothing changes.
    now += REFRESH_EVERY_MS;
    await sync.sync(calendar as never, false);
    expect(feeds.requests.at(-1)).toEqual({ path: '/f.ics', conditional: true, status: 304 });
    expect(titles()).toEqual(['First']);

    // Published again: Sync now reads it at once.
    feeds.feeds.set(
      '/f.ics',
      feedWith([
        { uid: 'a', summary: 'First, renamed', start: d(1) },
        { uid: 'b', summary: 'Second', start: `${d(2)}T09:00`, end: `${d(2)}T10:00` },
      ]),
    );
    await sync.sync(calendar as never, true);
    expect(feeds.requests.at(-1)).toMatchObject({ status: 200 });
    expect(titles()).toEqual(['First, renamed', 'Second']);
    // A floating 09:00 stays 09:00.
    expect(service.events(d(2), d(2)).find((e) => e.title === 'Second')).toMatchObject({
      start: `${d(2)}T09:00`,
      floating: true,
    });

    // An event removed from the feed goes.
    feeds.feeds.set('/f.ics', feedWith([{ uid: 'b', summary: 'Second', start: d(2) }]));
    await service.syncNow(true);
    expect(titles()).toEqual(['Second']);
  });

  it('follows redirects, and reads webcal:// as https://', async () => {
    feeds.feeds.set('/new.ics', feedWith([{ uid: 'r', summary: 'Moved feed', start: d(1) }]));
    feeds.redirects.set('/old.ics', '/new.ics');
    await service.subscribe(`${feeds.origin}/old.ics`);
    expect(titles()).toEqual(['Moved feed']);
    expect(feedUrl('webcal://example.com/cal.ics')).toBe('https://example.com/cal.ics');
    expect(() => feedUrl('ftp://example.com/x.ics')).toThrow(/https:\/\//);
  });

  it("refuses what isn't a feed, and marks one that went away", async () => {
    feeds.feeds.set('/page.html', '<!doctype html><title>Hi</title>');
    await expect(service.subscribe(`${feeds.origin}/page.html`)).rejects.toThrow(
      /isn't a calendar/,
    );
    await expect(service.subscribe(`${feeds.origin}/missing.ics`)).rejects.toThrow(
      /no longer at this address/,
    );
    await expect(service.subscribe('not a url')).rejects.toThrow(/isn't a web address/);
    expect(cache.calendars()).toEqual([]);

    feeds.feeds.set('/gone.ics', feedWith([{ uid: 'g', summary: 'Soon gone', start: d(1) }]));
    const calendar = await service.subscribe(`${feeds.origin}/gone.ics`);
    feeds.failures.set('/gone.ics', 410);
    await service.syncNow(true);
    expect(cache.calendar(calendar.id)).toMatchObject({
      status: 'no-access',
      statusMessage: expect.stringContaining('no longer at this address'),
    });
    // The events read before stay (offline-first), until the calendar is removed.
    expect(titles()).toEqual(['Soon gone']);

    // A server that can't be reached is "offline", not a broken calendar.
    feeds.failures.delete('/gone.ics');
    await service.syncNow(true);
    expect(cache.calendar(calendar.id)?.status).toBe('ok');
  });
});
