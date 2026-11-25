/**
 * The Workspace source against a real Workspace server (built from apps/server, on a
 * throwaway Postgres), through its public `/v1` API, with its production rate limits.
 */
import {
  seedWorkspace,
  startTestServer,
  type SeededWorkspace,
  type TestServer,
} from '@workspace/server/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, syncWindow, today } from '../src/shared/dates';
import type { WorkspaceCalendar as Calendar } from '../src/shared/types';
import { WorkspaceClient } from '../src/main/workspace/client';
import { calendarProblem, WorkspaceEngine } from '../src/main/workspace/engine';

let server: TestServer;
let seed: SeededWorkspace;
let engine: WorkspaceEngine;
/** Requests made by the test itself (not the code under test). */
let api: WorkspaceClient;

beforeAll(async () => {
  server = await startTestServer();
  seed = await seedWorkspace(server.base);
  engine = new WorkspaceEngine(
    new WorkspaceClient({ server: seed.base, token: seed.integration.token }),
  );
  api = new WorkspaceClient({ server: seed.base, token: seed.integration.token });
});
afterAll(() => server?.stop());

const d = (offset: number) => addDays(today(), offset);

async function makeDatabase(title: string) {
  const { body } = await api.request<{ id: string; properties: Record<string, { id: string }> }>(
    'POST',
    '/databases',
    {
      parent: { page_id: seed.pageId },
      title: [{ text: { content: title } }],
      properties: {
        Name: { title: {} },
        When: { date: {} },
        Owner: { people: {} },
        Kind: { select: { options: [{ name: 'Work', color: 'green' }] } },
      },
    },
  );
  return body;
}

async function addRow(databaseId: string, name: string, date: object | null, extra: object = {}) {
  const { body } = await api.request<{ id: string }>('POST', '/pages', {
    parent: { database_id: databaseId },
    properties: {
      Name: { title: [{ text: { content: name } }] },
      ...(date && { When: { date } }),
      ...extra,
    },
  });
  return body.id;
}

function calendarFor(db: { id: string; properties: Record<string, { id: string }> }): Calendar {
  return {
    id: `cal-${db.id}`,
    accountId: 'acc',
    databaseId: db.id,
    viewId: null,
    name: 'Tasks',
    colour: 'blue',
    visible: true,
    dateProperty: { id: db.properties.When!.id, name: 'When' },
    titleProperty: { id: db.properties.Name!.id, name: 'Name' },
    people: null,
    colourBy: null,
    status: 'ok',
    statusMessage: null,
  };
}

describe('connecting', () => {
  it('checks the token and names the integration', async () => {
    const me = await engine.connect();
    expect(me).toMatchObject({
      botId: seed.integration.id,
      name: 'Calendar',
      workspaceName: 'Lab',
    });
  });

  it('refuses a wrong token with a clear message', async () => {
    const wrong = new WorkspaceEngine(
      new WorkspaceClient({ server: seed.base, token: 'ntn_wrong' }),
    );
    await expect(wrong.connect()).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it("says when an address isn't a Workspace server", async () => {
    // The server's own non-API path answers, but not as the API.
    const other = new WorkspaceEngine(
      new WorkspaceClient({ server: `${seed.base}/nothing-here`, token: 't' }),
    );
    await expect(other.connect()).rejects.toMatchObject({ code: 'not_workspace' });
  });

  it('lists connected databases, their date properties and calendar views, and people', async () => {
    const db = await makeDatabase('Connecting');
    const databases = await engine.listDatabases();
    expect(databases).toContainEqual({ id: db.id, title: 'Connecting' });
    const schema = await engine.schema(db.id);
    expect(schema.properties).toContainEqual({
      id: db.properties.When!.id,
      name: 'When',
      type: 'date',
    });
    expect(await engine.calendarViews(db.id)).toEqual([]);
    expect(await engine.people()).toContainEqual({ id: seed.user.id, name: 'Ada' });
  });
});

describe('reading events', () => {
  it('reads the rows in the window, with wall-clock times', async () => {
    const db = await makeDatabase('Reading');
    const calendar = calendarFor(db);
    await addRow(db.id, 'Design review', { start: `${d(2)}T10:00`, end: `${d(2)}T11:30` });
    await addRow(db.id, 'Offsite', { start: d(3), end: d(5) });
    await addRow(db.id, 'No end', { start: `${d(4)}T23:30` });
    await addRow(db.id, 'Undated', null);
    await addRow(db.id, 'Long ago', { start: addDays(today(), -400) });

    const { events, serverTime } = await engine.fetchWindow(calendar, syncWindow());
    expect(serverTime).toEqual(expect.any(Number));
    const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
    expect(Object.keys(byTitle).sort()).toEqual(['Design review', 'No end', 'Offsite']);
    expect(byTitle['Design review']).toMatchObject({
      allDay: false,
      start: `${d(2)}T10:00`,
      end: `${d(2)}T11:30`,
      endSet: true,
      floating: true,
      url: expect.stringContaining(`/w/${seed.workspaceId}#page=`),
    });
    expect(byTitle.Offsite).toMatchObject({ allDay: true, start: d(3), end: d(5) });
    expect(byTitle['No end']).toMatchObject({
      start: `${d(4)}T23:30`,
      end: `${d(5)}T00:30`,
      endSet: false,
    });
  });

  it('reads only changed rows, and notices rows that left the calendar', async () => {
    const db = await makeDatabase('Changes');
    const calendar = calendarFor(db);
    const kept = await addRow(db.id, 'Kept', { start: d(1) });
    const moved = await addRow(db.id, 'Moved away', { start: d(1) });
    const first = await engine.fetchWindow(calendar, syncWindow());
    expect(first.events).toHaveLength(2);

    // Edits after the sync: one renamed, one moved out of the window, one trashed, one new.
    await new Promise((r) => setTimeout(r, 1100));
    const since = Date.now() - 1000;
    await api.request('PATCH', `/pages/${kept}`, {
      properties: { Name: { title: [{ text: { content: 'Kept, renamed' } }] } },
    });
    await api.request('PATCH', `/pages/${moved}`, {
      properties: { When: { date: { start: addDays(today(), 800) } } },
    });
    await addRow(db.id, 'New', { start: `${d(6)}T09:00` });

    const changed = await engine.fetchChanged(calendar, since, syncWindow());
    expect(changed.upserts.map((e) => e.title).sort()).toEqual(['Kept, renamed', 'New']);
    expect(changed.removed).toEqual([moved]);
  });

  it('drops trashed rows in the sweep (the window query no longer returns them)', async () => {
    const db = await makeDatabase('Sweep');
    const calendar = calendarFor(db);
    const gone = await addRow(db.id, 'Gone', { start: d(1) });
    await addRow(db.id, 'Stays', { start: d(1) });
    await api.request('PATCH', `/pages/${gone}`, { in_trash: true });
    const { events } = await engine.fetchWindow(calendar, syncWindow());
    expect(events.map((e) => e.title)).toEqual(['Stays']);
  });

  it('shows only the user\'s rows for "only mine"', async () => {
    const db = await makeDatabase('Mine');
    const calendar: Calendar = {
      ...calendarFor(db),
      people: { id: db.properties.Owner!.id, name: 'Owner', personId: seed.user.id },
      colourBy: { id: db.properties.Kind!.id, name: 'Kind' },
    };
    await addRow(
      db.id,
      'Mine',
      { start: d(1) },
      {
        Owner: { people: [{ id: seed.user.id }] },
        Kind: { select: { name: 'Work' } },
      },
    );
    await addRow(db.id, 'Nobody', { start: d(1) });
    const { events } = await engine.fetchWindow(calendar, syncWindow());
    expect(events.map((e) => [e.title, e.colour])).toEqual([['Mine', 'green']]);
  });
});

describe('writing events', () => {
  it('creates, moves, resizes, renames and trashes rows as the user sees them', async () => {
    const db = await makeDatabase('Writing');
    const calendar = calendarFor(db);
    const { event: created } = await engine.create(calendar, 'Standup', {
      allDay: false,
      start: `${d(1)}T09:00`,
      end: `${d(1)}T09:15`,
      endSet: true,
    });
    expect(created).toMatchObject({
      title: 'Standup',
      start: `${d(1)}T09:00`,
      end: `${d(1)}T09:15`,
    });

    const updated = await engine.update(calendar, created!.sourceId, {
      title: 'Standup (moved)',
      time: { allDay: false, start: `${d(2)}T10:30`, end: `${d(2)}T11:30`, endSet: true },
    });
    expect(updated).toMatchObject({ title: 'Standup (moved)', start: `${d(2)}T10:30` });

    // Workspace stored exactly the clock time shown (no zone conversion).
    const { body: row } = await api.request<{ properties: { When: { date: { start: string } } } }>(
      'GET',
      `/pages/${created!.sourceId}`,
    );
    expect(row.properties.When.date.start).toBe(`${d(2)}T10:30:00.000+00:00`);

    await engine.trash(created!.sourceId);
    const { events } = await engine.fetchWindow(calendar, syncWindow());
    expect(events).toEqual([]);
  });
});

describe('limits and lost access', () => {
  it('keeps going through real 429s by waiting for Retry-After', async () => {
    // Something else (another app with the same integration) has used up the server's burst.
    const other = new WorkspaceClient({
      server: seed.base,
      token: seed.integration.token,
      perSecond: 1000,
      burst: 1000,
      maxRetries: 0,
    });
    await Promise.allSettled(Array.from({ length: 30 }, () => other.request('GET', '/users/me')));

    // The calendar's client, with its real settings, still gets everything through.
    const statuses: number[] = [];
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await fetch(input, init);
      statuses.push(res.status);
      return res;
    }) as typeof fetch;
    const client = new WorkspaceClient({
      server: seed.base,
      token: seed.integration.token,
      fetch: counting,
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.request('GET', '/users/me').then(() => 'ok')),
    );
    expect(results).toEqual(Array(10).fill('ok'));
    expect(statuses).toContain(429);
  });

  it('marks a calendar whose date property is gone as needing setup', async () => {
    const db = await makeDatabase('Schema change');
    const calendar = calendarFor(db);
    await api.request('PATCH', `/databases/${db.id}`, { properties: { When: null } });
    const error = await engine.fetchWindow(calendar, syncWindow()).catch((e: unknown) => e);
    expect(calendarProblem(error, calendar)).toMatchObject({ status: 'needs-setup' });
  });

  it('marks a calendar the integration lost access to', async () => {
    const own = await seedWorkspace(server.base, 'Bea');
    const ownApi = new WorkspaceClient({ server: own.base, token: own.integration.token });
    const { body: db } = await ownApi.request<{
      id: string;
      properties: Record<string, { id: string }>;
    }>('POST', '/databases', {
      parent: { page_id: own.pageId },
      title: [{ text: { content: 'Private' } }],
      properties: { Name: { title: {} }, When: { date: {} } },
    });
    await own.setAccess(null);
    const ownEngine = new WorkspaceEngine(ownApi);
    const calendar = calendarFor(db);
    const error = await ownEngine.fetchWindow(calendar, syncWindow()).catch((e: unknown) => e);
    expect(calendarProblem(error, calendar)).toMatchObject({ status: 'no-access' });
  });
});
