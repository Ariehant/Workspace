import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import * as Y from 'yjs';
import { PgStore } from './store';
import { createTestDatabase } from './testing';

let store: PgStore;
beforeAll(async () => {
  store = new PgStore(await createTestDatabase(inject('pgUrl')));
  await store.migrate();
});
afterAll(() => store.close());

/** An update that sets `key` in the doc's map (from a fresh doc with its own client id). */
function edit(base: Uint8Array | null, key: string, value: string): Uint8Array {
  const doc = new Y.Doc();
  if (base) Y.applyUpdate(doc, base);
  const before = Y.encodeStateVector(doc);
  doc.getMap('m').set(key, value);
  return Y.encodeStateAsUpdate(doc, before);
}
const read = (state: Uint8Array | null) => {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  return doc.getMap('m').toJSON();
};

describe('PgStore', () => {
  it('migrates idempotently', async () => {
    expect(await store.migrate()).toBe(9);
    const { rows } = await store.pool.query('SELECT count(*)::int AS n FROM schema_migrations');
    expect(rows[0].n).toBe(9);
  });

  it('keeps an ordered update log per workspace', async () => {
    const a = await store.createWorkspace('A', null);
    const b = await store.createWorkspace('B', null);
    expect(await store.latestSeq(a.id)).toBe(0);
    const seqs = await store.appendUpdates(a.id, [
      { docId: 'page1', data: edit(null, 'title', 'Arm') },
      { docId: 'page2', data: edit(null, 'title', 'Base'), deviceId: 'laptop' },
    ]);
    expect(seqs).toEqual([1, 2]);
    expect(
      await store.appendUpdates(b.id, [{ docId: 'page1', data: edit(null, 'x', 'y') }]),
    ).toEqual([1]);
    expect(
      await store.appendUpdates(a.id, [{ docId: 'page1', data: edit(null, 'body', 'Two joints') }]),
    ).toEqual([3]);

    const since = await store.updatesSince(a.id, 1);
    expect(since.map((u) => [u.seq, u.docId, u.deviceId])).toEqual([
      [2, 'page2', 'laptop'],
      [3, 'page1', null],
    ]);
    expect(read(await store.docState(a.id, 'page1'))).toEqual({ title: 'Arm', body: 'Two joints' });
    // Workspaces don't see each other's docs.
    expect(read(await store.docState(b.id, 'page1'))).toEqual({ x: 'y' });
    expect(await store.docState(a.id, 'nope')).toBeNull();
    await expect(
      store.appendUpdates('00000000-0000-0000-0000-000000000000', [
        { docId: 'p', data: new Uint8Array([0, 0]) },
      ]),
    ).rejects.toThrow(/Unknown workspace/);
  });

  it('hands out distinct, ordered seqs under concurrent appends', async () => {
    const ws = await store.createWorkspace('Busy', null);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.appendUpdates(ws.id, [
          { docId: `d${i % 3}`, data: edit(null, 'k', String(i)) },
          { docId: `d${i % 3}`, data: edit(null, 'j', String(i)) },
        ]),
      ),
    );
    const all = results.flat().sort((x, y) => x - y);
    expect(all).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    for (const pair of results) expect(pair[1]).toBe(pair[0]! + 1);
    expect((await store.updatesSince(ws.id, 0, 1000)).map((u) => u.seq)).toEqual(all);
  });

  it('compacts a doc into one update under a new seq, keeping its state', async () => {
    const ws = await store.createWorkspace('C', null);
    let state: Uint8Array | null = null;
    for (const [k, v] of [
      ['a', '1'],
      ['b', '2'],
      ['c', '3'],
    ] as const) {
      const update = edit(state, k, v);
      await store.appendUpdates(ws.id, [{ docId: 'doc', data: update }]);
      state = await store.docState(ws.id, 'doc');
    }
    await store.appendUpdates(ws.id, [{ docId: 'other', data: edit(null, 'z', '9') }]);
    expect(await store.docsToCompact(ws.id, 2)).toEqual(['doc']);
    expect(await store.compactDoc(ws.id, 'doc')).toBe(5);
    expect(await store.compactDoc(ws.id, 'other')).toBeNull();
    expect(read(await store.docState(ws.id, 'doc'))).toEqual({ a: '1', b: '2', c: '3' });
    // A device that had seen seq 2 still gets the whole doc (the merged update).
    const after = await store.updatesSince(ws.id, 2);
    expect(after.map((u) => [u.seq, u.docId])).toEqual([
      [4, 'other'],
      [5, 'doc'],
    ]);
    expect(read(after[1]!.data)).toEqual({ a: '1', b: '2', c: '3' });
  });

  it('stores file metadata once per workspace', async () => {
    const ws = await store.createWorkspace('F', null);
    const file = { id: 'a'.repeat(64) + '.png', name: 'arm.png', mime: 'image/png', size: 1200 };
    await store.putFile(ws.id, file, null);
    await store.putFile(ws.id, { ...file, name: 'again.png' }, null);
    expect(await store.getFile(ws.id, file.id)).toEqual(file);
    expect(await store.storageUsed(ws.id)).toBe(1200);
  });
});
