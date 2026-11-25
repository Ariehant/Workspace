import { describe, expect, it } from 'vitest';
import type { EventTime } from '../shared/dates';
import type { Account, CalEvent, Calendar } from '../shared/types';
import { Cache } from './cache';
import { MAX_ATTEMPTS, Outbox, UNDO_MS } from './outbox';
import { WorkspaceApiError } from './workspace/client';
import type { WorkspaceEngine } from './workspace/engine';

const account: Account = {
  id: 'acc',
  kind: 'workspace',
  name: 'Lab',
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

const timed = (start: string, end: string): EventTime => ({
  allDay: false,
  start,
  end,
  endSet: true,
});

const server = (sourceId: string, title: string, time: EventTime, edited: string): CalEvent => ({
  id: `cal:${sourceId}`,
  calendarId: 'cal',
  sourceId,
  title,
  ...time,
  floating: !time.allDay,
  url: `https://notes.test/w/ws#page=${sourceId}`,
  colour: null,
  extra: [],
  lastEdited: edited,
});

/** A source that records requests; `fail` makes the next requests throw. */
function fakeEngine() {
  const requests: string[] = [];
  let n = 0;
  let edited = 100;
  const stamp = () => `2026-11-22T10:00:${String(edited++).padStart(2, '0')}.000Z`;
  const engine = {
    fail: [] as Error[],
    async create(_c: Calendar, title: string, time: EventTime) {
      requests.push(`create ${title} ${time.start}`);
      const error = engine.fail.shift();
      if (error) throw error;
      const sourceId = `row-${++n}`;
      return { sourceId, event: server(sourceId, title, time, stamp()) };
    },
    async update(_c: Calendar, sourceId: string, change: { title?: string; time?: EventTime }) {
      requests.push(
        `update ${sourceId}${change.title !== undefined ? ` title=${change.title}` : ''}${
          change.time ? ` start=${change.time.start}` : ''
        }`,
      );
      const error = engine.fail.shift();
      if (error) throw error;
      return server(
        sourceId,
        change.title ?? 'Unchanged',
        change.time ?? timed('2026-11-24T10:00', '2026-11-24T11:00'),
        stamp(),
      );
    },
    async trash(sourceId: string) {
      requests.push(`trash ${sourceId}`);
      const error = engine.fail.shift();
      if (error) throw error;
    },
  };
  return { engine, requests, asEngine: engine as unknown as WorkspaceEngine };
}

function setup() {
  const cache = new Cache(':memory:');
  cache.addAccount(account, 'x');
  cache.addCalendar(calendar);
  let now = 1_000_000;
  const fake = fakeEngine();
  const refused: string[] = [];
  const outbox = new Outbox({
    cache,
    engineFor: () => fake.asEngine,
    now: () => now,
    onRefused: (id) => refused.push(id),
  });
  const all = () => cache.eventsBetween('2026-01-01', '2027-12-31');
  return { cache, outbox, ...fake, refused, all, advance: (ms: number) => (now += ms) };
}

describe('creating', () => {
  it('shows a new event at once, then gives it the id its row got', async () => {
    const s = setup();
    const local = s.outbox.create('cal', 'Standup', timed('2026-11-24T09:00', '2026-11-24T09:15'));
    expect(local).toMatchObject({ pending: true, sourceId: expect.stringMatching(/^local-/) });
    await s.outbox.flush();
    expect(s.requests).toEqual(['create Standup 2026-11-24T09:00']);
    expect(s.all()).toEqual([
      expect.objectContaining({ id: 'cal:row-1', title: 'Standup', pending: false }),
    ]);
    expect(s.cache.ops()).toEqual([]);
  });

  it('folds edits made before sending into the one request', async () => {
    const s = setup();
    s.engine.fail.push(new WorkspaceApiError('network', "Can't reach notes.test."));
    const local = s.outbox.create('cal', 'Draft', timed('2026-11-24T09:00', '2026-11-24T10:00'));
    await s.outbox.flush(); // offline
    // A failed (not refused) try doesn't count, so the create still takes edits.
    s.outbox.update(local.id, { title: 'Review' });
    s.outbox.update(local.id, { time: timed('2026-11-25T14:00', '2026-11-25T15:00') });
    expect(s.cache.ops()).toHaveLength(1);
    s.advance(60_000);
    await s.outbox.flush();
    expect(s.requests).toEqual(['create Draft 2026-11-24T09:00', 'create Review 2026-11-25T14:00']);
  });
});

describe('changing', () => {
  it('shows an edit at once and sends it', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.outbox.update('cal:row-9', { time: timed('2026-11-24T12:00', '2026-11-24T13:00') });
    expect(s.cache.event('cal:row-9')).toMatchObject({ start: '2026-11-24T12:00', pending: true });
    await s.outbox.flush();
    expect(s.requests).toEqual(['update row-9 start=2026-11-24T12:00']);
    expect(s.cache.event('cal:row-9')).toMatchObject({ pending: false });
  });

  it("doesn't fold an edit into one already on its way (it would be lost)", async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Retro', timed('2026-11-24T15:00', '2026-11-24T16:00'), 'T1'));
    // The first request waits until the test lets it answer.
    let answer!: () => void;
    const original = s.engine.update;
    s.engine.update = async (...args) => {
      if (s.requests.length === 0) await new Promise<void>((r) => (answer = r));
      return original(...args);
    };
    s.outbox.update('cal:row-9', { title: 'Sprint retro' }); // starts sending at once
    await Promise.resolve();
    s.outbox.update('cal:row-9', { time: timed('2026-11-24T16:30', '2026-11-24T17:30') });
    expect(s.cache.event('cal:row-9')).toMatchObject({
      title: 'Sprint retro',
      start: '2026-11-24T16:30',
    });
    answer();
    await s.outbox.flush();
    expect(s.requests).toEqual([
      'update row-9 title=Sprint retro',
      'update row-9 start=2026-11-24T16:30',
    ]);
    expect(s.cache.event('cal:row-9')).toMatchObject({ start: '2026-11-24T16:30', pending: false });
  });

  it("doesn't take its own sent edit for a change made elsewhere", async () => {
    const s = setup();
    s.cache.putEvent(
      server(
        'row-9',
        'Retro',
        timed('2026-11-24T15:00', '2026-11-24T16:00'),
        '2026-11-22T09:00:00.000Z',
      ),
    );
    // The first edit waits for the test to let it answer; then the source goes offline.
    let answer!: () => void;
    let calls = 0;
    const original = s.engine.update;
    s.engine.update = async (...args) => {
      if (++calls > 1) throw new WorkspaceApiError('network', "Can't reach notes.test.");
      await new Promise<void>((r) => (answer = r));
      return original(...args);
    };
    s.outbox.update('cal:row-9', { title: 'Sprint retro' });
    await Promise.resolve();
    // The second edit is made while the first is on its way.
    s.outbox.update('cal:row-9', { time: timed('2026-11-24T16:30', '2026-11-24T17:30') });
    answer();
    await s.outbox.flush();
    const sent = s.cache.event('cal:row-9')!;
    // A sync now reads back the first edit (newer than when the second was made).
    s.cache.replaceEvents('cal', [
      server(
        'row-9',
        'Sprint retro',
        timed('2026-11-24T15:00', '2026-11-24T16:00'),
        sent.lastEdited,
      ),
    ]);
    expect(s.cache.event('cal:row-9')).toMatchObject({ start: '2026-11-24T16:30' });
    expect(s.cache.event('cal:row-9')?.conflict ?? null).toBeNull();
  });

  it('keeps edits while offline and sends them when back', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.engine.fail.push(new WorkspaceApiError('network', "Can't reach notes.test."));
    s.outbox.update('cal:row-9', { title: 'Plan B' });
    await s.outbox.flush();
    expect(s.cache.event('cal:row-9')).toMatchObject({ title: 'Plan B', pending: true });
    expect(s.outbox.status().pending).toBe(1);
    // Nothing is tried again before the backoff ends.
    await s.outbox.flush();
    expect(s.requests).toHaveLength(1);
    s.advance(6_000);
    await s.outbox.flush();
    expect(s.requests).toHaveLength(2);
    expect(s.outbox.status().pending).toBe(0);
  });

  it('drops an edit the source keeps refusing, and reads the calendar again', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    for (let i = 0; i < MAX_ATTEMPTS; i++)
      s.engine.fail.push(new WorkspaceApiError('validation_error', 'Bad date.', 400));
    s.outbox.update('cal:row-9', { title: 'Plan B' });
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await s.outbox.flush();
      s.advance(10 * 60_000);
    }
    expect(s.requests).toHaveLength(MAX_ATTEMPTS);
    expect(s.cache.ops()).toEqual([]);
    expect(s.outbox.status().error).toContain('Bad date.');
    expect(s.refused).toEqual(['cal']);
  });

  it('keeps edits through a bad token (nothing is dropped for it)', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    const badToken = () =>
      new WorkspaceApiError('unauthorized', 'The token was not accepted.', 401);
    s.engine.fail.push(badToken());
    s.outbox.update('cal:row-9', { title: 'Plan B' }); // sends at once, and is refused
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) {
      await s.outbox.flush();
      s.advance(10 * 60_000);
      s.engine.fail.push(badToken());
    }
    expect(s.requests.length).toBeGreaterThan(MAX_ATTEMPTS);
    expect(s.cache.ops()).toHaveLength(1);
  });

  it('forgets an edit to a row that is gone', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.engine.fail.push(new WorkspaceApiError('object_not_found', 'Could not find page.', 404));
    s.outbox.update('cal:row-9', { title: 'Plan B' });
    await s.outbox.flush();
    expect(s.cache.ops()).toEqual([]);
    expect(s.cache.event('cal:row-9')).toBeNull();
  });
});

describe('deleting', () => {
  it('hides the event at once and sends nothing before Undo runs out', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.outbox.remove('cal:row-9');
    expect(s.all()).toEqual([]);
    await s.outbox.flush();
    expect(s.requests).toEqual([]);
    expect(s.outbox.nextDue()).toBe(1_000_000 + UNDO_MS);
    s.advance(UNDO_MS);
    await s.outbox.flush();
    expect(s.requests).toEqual(['trash row-9']);
  });

  it('brings the event back on Undo, and never sends the delete', async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.outbox.remove('cal:row-9');
    const back = s.outbox.undoRemove('cal:row-9');
    expect(back).toMatchObject({ id: 'cal:row-9', title: 'Plan' });
    s.advance(UNDO_MS * 2);
    await s.outbox.flush();
    expect(s.requests).toEqual([]);
    expect(s.outbox.undoRemove('cal:row-9')).toBeNull();
  });

  it('deletes an event made offline once it has been created', async () => {
    const s = setup();
    s.engine.fail.push(new WorkspaceApiError('network', "Can't reach notes.test."));
    const local = s.outbox.create('cal', 'Oops', timed('2026-11-24T09:00', '2026-11-24T10:00'));
    await s.outbox.flush();
    s.outbox.remove(local.id);
    s.advance(60_000);
    await s.outbox.flush();
    expect(s.requests).toEqual([
      'create Oops 2026-11-24T09:00',
      'create Oops 2026-11-24T09:00',
      'trash row-1',
    ]);
    expect(s.all()).toEqual([]);
  });
});

describe('syncing while edits wait', () => {
  it("doesn't overwrite an edit waiting to be sent, and notes a change made elsewhere", async () => {
    const s = setup();
    s.cache.putEvent(server('row-9', 'Plan', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T1'));
    s.engine.fail.push(new WorkspaceApiError('network', "Can't reach notes.test."));
    s.outbox.update('cal:row-9', { title: 'Mine' });
    await s.outbox.flush();

    // Someone renamed it in Workspace meanwhile.
    s.cache.replaceEvents('cal', [
      server('row-9', 'Theirs', timed('2026-11-24T10:00', '2026-11-24T11:00'), 'T2'),
    ]);
    expect(s.cache.event('cal:row-9')).toMatchObject({
      title: 'Mine',
      conflict: { title: 'Theirs' },
    });

    // The edit still goes (last write wins); "Changed elsewhere" stays until dismissed.
    s.advance(60_000);
    await s.outbox.flush();
    expect(s.cache.event('cal:row-9')).toMatchObject({
      title: 'Mine',
      pending: false,
      conflict: { title: 'Theirs' },
    });
    s.outbox.dismissConflict('cal:row-9');
    expect(s.cache.event('cal:row-9')?.conflict).toBeNull();
  });

  it("doesn't let an older read undo an edit just sent, or drop an event made after it", () => {
    const s = setup();
    s.cache.putEvent(
      server(
        'row-9',
        'New title',
        timed('2026-11-24T10:00', '2026-11-24T11:00'),
        '2026-11-22T10:05:00.000Z',
      ),
    );
    s.cache.putEvent(
      server(
        'row-10',
        'Just made',
        timed('2026-11-24T12:00', '2026-11-24T13:00'),
        '2026-11-22T10:05:01.000Z',
      ),
    );
    // A window read that started at 10:04, before both.
    s.cache.replaceEvents(
      'cal',
      [
        server(
          'row-9',
          'Old title',
          timed('2026-11-24T10:00', '2026-11-24T11:00'),
          '2026-11-22T10:00:00.000Z',
        ),
      ],
      '2026-11-22T10:04:00.000Z',
    );
    expect(
      s
        .all()
        .map((e) => e.title)
        .sort(),
    ).toEqual(['Just made', 'New title']);
  });
});
