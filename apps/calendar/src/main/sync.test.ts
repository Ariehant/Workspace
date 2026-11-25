import { describe, expect, it } from 'vitest';
import type { Account, CalEvent, Calendar } from '../shared/types';
import { Cache, lastDayOf } from './cache';
import { SyncService } from './sync';
import { WorkspaceApiError } from './workspace/client';
import type { WorkspaceEngine } from './workspace/engine';

const account: Account = {
  id: 'acc',
  kind: 'workspace',
  name: 'Calendar · notes.test',
  server: 'https://notes.test',
  botId: 'bot',
  error: null,
};

const calendar: Calendar = {
  id: 'cal',
  accountId: 'acc',
  databaseId: 'db',
  viewId: null,
  name: 'Tasks',
  colour: 'blue',
  visible: true,
  dateProperty: { id: 'x1', name: 'When' },
  titleProperty: { id: 'title', name: 'Name' },
  people: null,
  colourBy: null,
  status: 'ok',
  statusMessage: null,
};

const event = (sourceId: string, title: string, start = '2026-11-24'): CalEvent => ({
  id: `cal:${sourceId}`,
  calendarId: 'cal',
  sourceId,
  title,
  allDay: start.length === 10,
  start,
  end: start.length === 10 ? start : start.replace(/T\d\d:\d\d/, 'T23:00'),
  endSet: true,
  floating: start.length > 10,
  url: null,
  colour: null,
  extra: [],
  lastEdited: '2026-11-20T00:00:00.000Z',
});

/** A source whose answers the test sets, recording what was asked. */
function fakeEngine() {
  const calls: string[] = [];
  const engine = {
    window: [] as CalEvent[],
    changes: { upserts: [] as CalEvent[], removed: [] as string[] },
    fail: null as Error | null,
    serverTime: 5_000_000,
    async fetchWindow() {
      calls.push('window');
      if (engine.fail) throw engine.fail;
      return { events: engine.window, serverTime: engine.serverTime };
    },
    async fetchChanged(_c: Calendar, since: number) {
      calls.push(`changed since ${since}`);
      if (engine.fail) throw engine.fail;
      return { ...engine.changes, serverTime: engine.serverTime };
    },
  };
  return { engine, calls, asEngine: engine as unknown as WorkspaceEngine };
}

function setup() {
  const cache = new Cache(':memory:');
  cache.addAccount(account, '{"enc":"plain","value":"t"}');
  cache.addCalendar(calendar);
  let now = 1_000_000;
  const fake = fakeEngine();
  const sync = new SyncService({
    cache,
    engineFor: () => fake.asEngine,
    now: () => now,
  });
  return { cache, sync, ...fake, advance: (ms: number) => (now += ms) };
}

describe('the cache', () => {
  it('finds events by the days they touch', () => {
    const cache = new Cache(':memory:');
    cache.addAccount(account, 'x');
    cache.addCalendar(calendar);
    cache.replaceEvents('cal', [
      event('a', 'Monday', '2026-11-23'),
      { ...event('b', 'Long', '2026-11-20'), end: '2026-11-26' },
      event('c', 'Next week', '2026-12-01'),
    ]);
    expect(cache.eventsBetween('2026-11-23', '2026-11-29').map((e) => e.title)).toEqual([
      'Long',
      'Monday',
    ]);
  });

  it('ends a timed event at midnight on the day before', () => {
    expect(lastDayOf({ allDay: false, start: '2026-11-24T22:00', end: '2026-11-25T00:00' })).toBe(
      '2026-11-24',
    );
    expect(lastDayOf({ allDay: false, start: '2026-11-24T22:00', end: '2026-11-25T00:30' })).toBe(
      '2026-11-25',
    );
  });

  it('migrates a new file and opens it again', () => {
    const cache = new Cache(':memory:');
    expect(cache.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  });
});

describe('syncing', () => {
  it('reads the whole window first, then only changes since the server time', async () => {
    const s = setup();
    s.engine.window = [event('a', 'A'), event('b', 'B')];
    await s.sync.syncAll();
    expect(s.calls).toEqual(['window']);
    expect(s.cache.eventsBetween('2026-01-01', '2027-12-31').map((e) => e.title)).toEqual([
      'A',
      'B',
    ]);

    s.advance(60_000);
    s.engine.changes = { upserts: [event('a', 'A, renamed'), event('c', 'C')], removed: ['b'] };
    await s.sync.syncAll();
    expect(s.calls[1]).toBe('changed since 5000000');
    expect(s.cache.eventsBetween('2026-01-01', '2027-12-31').map((e) => e.title)).toEqual([
      'A, renamed',
      'C',
    ]);
  });

  it('sweeps every 15 minutes, dropping rows that are gone', async () => {
    const s = setup();
    s.engine.window = [event('a', 'A'), event('b', 'B')];
    await s.sync.syncAll();
    s.advance(14 * 60_000);
    await s.sync.syncAll();
    expect(s.calls).toEqual(['window', 'changed since 5000000']);
    s.advance(60_000);
    s.engine.window = [event('a', 'A')];
    await s.sync.syncAll();
    expect(s.calls.at(-1)).toBe('window');
    expect(s.cache.eventCount('cal')).toBe(1);
  });

  it('marks a calendar that lost access, and clears it when access is back', async () => {
    const s = setup();
    s.engine.fail = new WorkspaceApiError('object_not_found', 'Could not find database.', 404);
    await s.sync.syncAll();
    expect(s.cache.calendar('cal')).toMatchObject({ status: 'no-access' });
    expect(s.cache.calendar('cal')?.statusMessage).toContain('Share → Connections');
    s.engine.fail = null;
    await s.sync.syncAll();
    expect(s.cache.calendar('cal')).toMatchObject({ status: 'ok', statusMessage: null });
  });

  it('marks the account when its token stops working', async () => {
    const s = setup();
    s.engine.fail = new WorkspaceApiError('unauthorized', 'The token was not accepted.', 401);
    await s.sync.syncAll();
    expect(s.cache.account('acc')?.error).toBe('The token was not accepted.');
    expect(s.sync.status.online).toBe(true);
  });

  it('goes offline without losing what it has', async () => {
    const s = setup();
    s.engine.window = [event('a', 'A')];
    await s.sync.syncAll();
    s.engine.fail = new WorkspaceApiError('network', "Can't reach notes.test.");
    s.advance(60_000);
    await s.sync.syncAll();
    expect(s.sync.status.online).toBe(false);
    expect(s.cache.eventCount('cal')).toBe(1);
    s.engine.fail = null;
    await s.sync.syncAll();
    expect(s.sync.status.online).toBe(true);
  });

  it('runs once at a time, and once more if asked during a run', async () => {
    const s = setup();
    const first = s.sync.syncAll();
    const second = s.sync.syncAll();
    const third = s.sync.syncAll();
    await Promise.all([first, second, third]);
    expect(s.calls).toHaveLength(2);
  });

  it('leaves alone a calendar removed while its rows were being read', async () => {
    const s = setup();
    s.engine.window = [event('a', 'A')];
    const original = s.engine.fetchWindow;
    s.engine.fetchWindow = async () => {
      const result = await original();
      s.cache.removeCalendar('cal');
      return result;
    };
    await s.sync.syncAll();
    expect(s.sync.status.error).toBeNull();
    expect(s.cache.eventsBetween('2026-01-01', '2027-12-31')).toEqual([]);
  });

  it('notes an account whose token is unreadable here', async () => {
    const cache = new Cache(':memory:');
    cache.addAccount(account, 'x');
    cache.addCalendar(calendar);
    const sync = new SyncService({ cache, engineFor: () => null });
    await sync.syncAll();
    expect(cache.account('acc')?.error).toContain("can't be read");
  });
});
