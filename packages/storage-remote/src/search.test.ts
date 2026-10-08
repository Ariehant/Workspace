import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { toTsQuery } from './search';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

const page = (id: string, title: string, extra = {}) => ({
  id,
  title,
  icon: null,
  inTrash: false,
  updatedAt: 1,
  ...extra,
});

describe('search index', () => {
  it('turns typed text into a safe prefix query', () => {
    expect(toTsQuery('Robo ARM')).toBe('robo:* & arm:*');
    expect(toTsQuery("o'brien & | ! :*")).toBe('o:* & brien:*');
    expect(toTsQuery('  ')).toBeNull();
    expect(toTsQuery('Größe 2Nm')).toBe('größe:* & 2nm:*');
  });

  it('finds pages and rows by title, properties and content, by prefix', async () => {
    const ws = await store.createWorkspace('W', null);
    const s = store.search;
    // Content can arrive before the page it belongs to: it waits, unsearchable.
    await s.setBody(ws.id, 'p1', 'The gripper uses a harmonic drive.');
    expect(await s.search(ws.id, 'harmonic')).toEqual([]);

    await s.setPages(ws.id, null, [page('p1', 'Gripper design'), page('db', 'Parts')]);
    await s.setRows(ws.id, 'db', null, [
      { ...page('r1', 'Servo motor'), props: 'Supplier: Dynamixel\nIn stock' },
      { ...page('r2', 'Old motor'), props: 'Dynamixel', inTrash: true },
    ]);
    await s.setBody(ws.id, 'r1', 'Torque 2 Nm at 12 V');

    const hits = await s.search(ws.id, 'harm');
    expect(hits).toEqual([
      {
        id: 'p1',
        title: 'Gripper design',
        icon: null,
        databaseId: null,
        snippet: expect.stringContaining('[harmonic]'),
      },
    ]);
    expect((await s.search(ws.id, 'dynam')).map((h) => [h.id, h.databaseId])).toEqual([
      ['r1', 'db'],
    ]);
    expect((await s.search(ws.id, 'torque 12')).map((h) => h.id)).toEqual(['r1']);
    expect(await s.locate(ws.id, 'r1')).toEqual({ databaseId: 'db' });
    expect(await s.locate(ws.id, 'p1')).toEqual({ databaseId: null });
    expect(await s.locate(ws.id, 'nope')).toBeNull();
    // Every word must match.
    expect(await s.search(ws.id, 'gripper torque')).toEqual([]);
    // A title match ranks above a content match.
    await s.setBody(ws.id, 'db', 'A list of every gripper part.');
    expect((await s.search(ws.id, 'gripper')).map((h) => h.id)).toEqual(['p1', 'db']);

    // Trashed pages, and rows of a trashed database, are left out.
    await s.setPages(ws.id, null, [
      page('p1', 'Gripper design'),
      page('db', 'Parts', { inTrash: true }),
    ]);
    expect(await s.search(ws.id, 'servo')).toEqual([]);
    // Pages and rows that are gone are removed.
    await s.setPages(ws.id, null, [page('db', 'Parts')]);
    await s.setRows(ws.id, 'db', null, []);
    expect(await s.search(ws.id, 'gripper')).toEqual([expect.objectContaining({ id: 'db' })]);
    expect(await s.search(ws.id, 'servo')).toEqual([]);

    // Other workspaces see nothing.
    const other = await store.createWorkspace('Other', null);
    expect(await s.search(other.id, 'parts')).toEqual([]);
  });

  it('filters by scope: pages by their tree, rows by their database', async () => {
    const ws = await store.createWorkspace('Scoped', null);
    const s = store.search;
    const [a, b] = [randomUUID(), randomUUID()];
    await s.setPages(ws.id, a, [page('pa', 'Alpha plan'), page('dba', 'Alpha parts')]);
    await s.setPages(ws.id, b, [page('pb', 'Beta plan')]);
    await s.setRows(ws.id, 'dba', a, [{ ...page('ra', 'Alpha servo'), props: '' }]);
    const ids = async (q: string, scopes: string[] | null) =>
      (await s.search(ws.id, q, 20, scopes)).map((h) => h.id).sort();
    expect(await ids('plan', null)).toEqual(['pa', 'pb']);
    expect(await ids('plan', [a])).toEqual(['pa']);
    expect(await ids('alpha', [b])).toEqual([]);
    expect(await ids('servo', [a])).toEqual(['ra']);
    expect(await ids('plan', [])).toEqual([]);
    expect(await s.locate(ws.id, 'ra', [b])).toBeNull();
    expect(await s.locate(ws.id, 'ra', [a])).toEqual({ databaseId: 'dba' });
    // Each tree replaces only its own pages; a page that moved keeps its new scope.
    await s.setPages(ws.id, b, [page('pb', 'Beta plan'), page('pa', 'Alpha plan')]);
    await s.setPages(ws.id, a, [page('dba', 'Alpha parts')]);
    expect(await ids('plan', [b])).toEqual(['pa', 'pb']);
  });

  it('tracks how far into the log the index is', async () => {
    const ws = await store.createWorkspace('Log', null);
    const s = store.search;
    const up = (docId: string) => ({ docId, data: new Uint8Array([0, 0]) });
    await store.appendUpdates(ws.id, [up('a'), up('b'), up('a')]);
    expect(await s.behind()).toContain(ws.id);
    expect(await s.changedSince(ws.id, 0)).toEqual({ docIds: ['a', 'b'], lastSeq: 3 });
    expect(await s.changedSince(ws.id, 0, 1)).toEqual({ docIds: ['a'], lastSeq: 1 });
    await s.setIndexedSeq(ws.id, 3);
    await s.setIndexedSeq(ws.id, 2);
    expect(await s.indexedSeq(ws.id)).toBe(3);
    expect(await s.behind()).not.toContain(ws.id);
    await s.clear(ws.id);
    expect(await s.indexedSeq(ws.id)).toBe(0);
  });
});
