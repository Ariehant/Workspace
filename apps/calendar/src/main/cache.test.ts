import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { CalEvent, GoogleCalendar } from '../shared/types';
import { wallAt } from '../shared/zones';
import { Cache, MIGRATIONS } from './cache';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'calendar-cache-'));
  dirs.push(dir);
  return join(dir, 'cache.db');
};

const calendar: GoogleCalendar = {
  id: 'g',
  kind: 'google',
  accountId: 'acc',
  googleId: 'ada@lab.io',
  accessRole: 'owner',
  timeZone: 'Europe/Berlin',
  name: 'Ada',
  colour: '#9fe1e7',
  visible: true,
  status: 'ok',
  statusMessage: null,
};

const event = (id: string, extra: Partial<CalEvent> = {}): CalEvent => ({
  id: `g:${id}`,
  calendarId: 'g',
  sourceId: id,
  title: id,
  allDay: false,
  start: '2026-11-24T10:00',
  end: '2026-11-24T11:00',
  endSet: true,
  floating: false,
  url: null,
  colour: null,
  extra: [],
  lastEdited: '2026-11-20T00:00:00.000Z',
  ...extra,
});

describe('the cache', () => {
  it('upgrades a v1.0 cache, keeping its accounts, calendars and events', () => {
    const path = tempPath();
    const old = new DatabaseSync(path);
    for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
    old.exec('PRAGMA user_version = 3');
    old.exec(`INSERT INTO accounts VALUES ('acc', '{"id":"acc","name":"Lab"}', 'sealed', 0);
      INSERT INTO calendars (id, account_id, json, position) VALUES ('w', 'acc', '{"id":"w"}', 0);
      INSERT INTO events (id, calendar_id, source_id, first_day, last_day, title, json)
        VALUES ('w:1', 'w', '1', '2026-11-24', '2026-11-24', 'Kept', '{"id":"w:1"}');`);
    old.close();

    const cache = new Cache(path);
    expect(
      (cache.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    ).toBe(MIGRATIONS.length);
    expect(cache.accounts()).toEqual([{ id: 'acc', name: 'Lab' }]);
    expect(cache.event('w:1')).toEqual({ id: 'w:1' });
    expect(cache.cursor('w')).toBeNull();
    cache.close();
  });

  it('keeps source items and a cursor per calendar, dropped with the calendar', () => {
    const cache = new Cache(':memory:');
    cache.addAccount({ id: 'acc', kind: 'google', name: 'Ada', email: 'ada@lab.io', error: null }, 's');
    cache.addCalendar(calendar);
    cache.putItem('g', { sourceId: 'series', seriesId: null, data: { id: 'series' } });
    cache.putItem('g', { sourceId: 'series_1', seriesId: 'series', data: { id: 'series_1' } });
    cache.putItem('g', { sourceId: 'single', seriesId: null, data: { id: 'single' } });
    cache.setCursor('g', 'token-1');
    expect(cache.cursor('g')).toBe('token-1');

    // A series goes with its occurrences.
    cache.removeItem('g', 'series');
    expect(cache.items('g').map((i) => i.sourceId)).toEqual(['single']);

    cache.removeCalendar('g');
    expect(cache.items('g')).toEqual([]);
  });

  it('writes only the derived events that changed, and keeps ones with edits waiting', () => {
    const cache = new Cache(':memory:');
    cache.addAccount({ id: 'acc', kind: 'google', name: 'Ada', email: 'ada@lab.io', error: null }, 's');
    cache.addCalendar(calendar);
    cache.setDerivedEvents('g', [event('a'), event('b'), event('c')]);
    cache.addOp({ eventId: 'g:c', calendarId: 'g', kind: 'update', payload: { title: 'C2' }, notBefore: 0, baseEdited: null });

    let writes = 0;
    const put = cache.putEvent.bind(cache);
    cache.putEvent = (e) => {
      writes++;
      put(e);
    };
    cache.setDerivedEvents('g', [event('a'), event('b', { title: 'B2' })]);
    expect(writes).toBe(1);
    expect(cache.eventsBetween('2026-11-01', '2026-11-30').map((e) => e.title).sort()).toEqual([
      'B2',
      'a',
      'c',
    ]);
  });

  it('works out clock times again for events at real instants', () => {
    const cache = new Cache(':memory:');
    cache.addAccount({ id: 'acc', kind: 'google', name: 'Ada', email: 'ada@lab.io', error: null }, 's');
    cache.addCalendar(calendar);
    cache.setDerivedEvents('g', [
      event('timed', { instant: { start: '2026-11-24T09:00:00.000Z', end: '2026-11-24T10:00:00.000Z' } }),
      event('floating', { floating: true }),
    ]);
    cache.relocalize((t) => wallAt(t, 'America/New_York'));
    expect(cache.event('g:timed')).toMatchObject({ start: '2026-11-24T04:00', end: '2026-11-24T05:00' });
    expect(cache.event('g:floating')).toMatchObject({ start: '2026-11-24T10:00' });
  });
});
