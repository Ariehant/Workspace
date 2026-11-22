/**
 * Edits made in the calendar reach Workspace (HANDOFF.md 3.7): created, moved, resized,
 * renamed and deleted (with Undo) through the whole main-process service, against a real
 * Workspace server.
 */
import {
  seedWorkspace,
  startTestServer,
  type SeededWorkspace,
  type TestServer,
} from '@workspace/server/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { addDays, today } from '../src/shared/dates';
import { Cache } from '../src/main/cache';
import { UNDO_MS } from '../src/main/outbox';
import { CalendarService } from '../src/main/service';
import { WorkspaceClient } from '../src/main/workspace/client';

let server: TestServer;
let seed: SeededWorkspace;
let api: WorkspaceClient;

beforeAll(async () => {
  server = await startTestServer();
  seed = await seedWorkspace(server.base);
  api = new WorkspaceClient({ server: seed.base, token: seed.integration.token });
});
afterAll(() => server?.stop());

const d = (offset: number) => addDays(today(), offset);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function row(id: string) {
  const { body } = await api.request<{
    in_trash: boolean;
    properties: {
      Name: { title: { plain_text: string }[] };
      When: { date: { start: string; end: string | null } | null };
    };
  }>('GET', `/pages/${id}`);
  const date = body.properties.When.date;
  return {
    title: body.properties.Name.title.map((t) => t.plain_text).join(''),
    date: date && { start: date.start, end: date.end },
    trashed: body.in_trash,
  };
}

it('creates, moves, resizes, renames and deletes rows in Workspace', async () => {
  const { body: db } = await api.request<{ id: string }>('POST', '/databases', {
    parent: { page_id: seed.pageId },
    title: [{ text: { content: 'Edits' } }],
    properties: { Name: { title: {} }, When: { date: {} } },
  });

  const service = new CalendarService({
    cache: new Cache(':memory:'),
    seal: (token) => JSON.stringify({ enc: 'plain', value: token }),
    unseal: (sealed) => (JSON.parse(sealed) as { value: string }).value,
    secureStorage: () => false,
  });
  const session = await service.connectNew(seed.base, seed.integration.token);
  const schema = await service.schema(session.sessionId, db.id);
  const prop = (type: string) => {
    const p = schema.properties.find((x) => x.type === type)!;
    return { id: p.id, name: p.name };
  };
  await service.save(session.sessionId, [
    {
      databaseId: db.id,
      viewId: null,
      name: 'Edits',
      colour: 'blue',
      dateProperty: prop('date'),
      titleProperty: prop('title'),
      people: null,
      colourBy: null,
    },
  ]);
  const calendar = service.cache.calendars()[0]!;

  // Create: shown at once, then a row in Workspace with the clock time as shown.
  const local = service.createEvent(calendar.id, 'Standup', {
    allDay: false,
    start: `${d(1)}T09:00`,
    end: `${d(1)}T09:15`,
    endSet: true,
  });
  expect(service.events(d(1), d(1))).toEqual([expect.objectContaining({ title: 'Standup' })]);
  await service.outbox.flush();
  const created = service.events(d(1), d(1))[0]!;
  expect(created.id).not.toBe(local.id);
  expect(created).toMatchObject({ pending: false, url: expect.stringContaining('#page=') });
  expect(await row(created.sourceId)).toEqual({
    title: 'Standup',
    date: { start: `${d(1)}T09:00:00.000+00:00`, end: `${d(1)}T09:15:00.000+00:00` },
    trashed: false,
  });

  // Move to another day, resize, rename.
  service.updateEvent(created.id, {
    time: { allDay: false, start: `${d(2)}T14:00`, end: `${d(2)}T14:15`, endSet: true },
  });
  await service.outbox.flush();
  service.updateEvent(created.id, {
    time: { allDay: false, start: `${d(2)}T14:00`, end: `${d(2)}T15:30`, endSet: true },
    title: 'Planning',
  });
  await service.outbox.flush();
  expect(await row(created.sourceId)).toEqual({
    title: 'Planning',
    date: { start: `${d(2)}T14:00:00.000+00:00`, end: `${d(2)}T15:30:00.000+00:00` },
    trashed: false,
  });

  // To all day.
  service.updateEvent(created.id, {
    time: { allDay: true, start: d(3), end: d(3), endSet: false },
  });
  await service.outbox.flush();
  expect((await row(created.sourceId)).date).toEqual({ start: d(3), end: null });

  // Delete, then Undo: nothing reaches Workspace.
  service.deleteEvent(created.id);
  expect(service.events(d(3), d(3))).toEqual([]);
  expect(service.undoDelete(created.id)).toMatchObject({ title: 'Planning' });
  await wait(UNDO_MS + 300);
  await service.outbox.flush();
  expect((await row(created.sourceId)).trashed).toBe(false);

  // Delete for real: in Workspace's trash once Undo's time is up.
  service.deleteEvent(created.id);
  await service.outbox.flush();
  expect((await row(created.sourceId)).trashed).toBe(false);
  await wait(UNDO_MS + 300);
  await service.outbox.flush();
  expect((await row(created.sourceId)).trashed).toBe(true);

  // A sync afterwards agrees with what's shown.
  await service.syncNow(true);
  expect(service.events(d(-1), d(5))).toEqual([]);
  service.stop();
}, 60_000);
