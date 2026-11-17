import { NoAccessError, type PartialClient, type PushItem } from '@workspace/sync';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { OfflineDocs, type OfflineStore } from './offline';

/** A store in memory, shaped like the IndexedDB one. */
function memoryStore() {
  const docs = new Map<string, Uint8Array>();
  const kept = new Map<string, unknown>();
  const store = {
    getDoc: async (id: string) => docs.get(id) ?? null,
    putDoc: async (id: string, state: Uint8Array) => docs.set(id, state),
    deleteDoc: async (id: string) => docs.delete(id),
    get: async (name: string) => kept.get(name) ?? null,
    put: async (name: string, value: unknown) => kept.set(name, value),
  };
  return { store: store as unknown as OfflineStore, docs, kept };
}

/** A client whose `open` resolves when told (as the server answers). */
function fakeClient() {
  const opens = new Map<string, { resolve(s: Uint8Array): void; reject(e: Error): void }>();
  const pushed: { docId: string; scope?: string | null }[] = [];
  const client = {
    open: (docId: string) =>
      new Promise<Uint8Array>((resolve, reject) => opens.set(docId, { resolve, reject })),
    close: () => {},
    push: (docId: string, _update: Uint8Array, scope?: string | null) =>
      pushed.push({ docId, scope }),
  };
  return { client: client as unknown as PartialClient, opens, pushed };
}

const text = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getText('t').toString();
};
const edit = (state: Uint8Array | null, add: string) => {
  const doc = new Y.Doc();
  if (state) Y.applyUpdate(doc, state);
  const before = Y.encodeStateVector(doc);
  doc.getText('t').insert(doc.getText('t').length, add);
  return { update: Y.encodeStateAsUpdate(doc, before), state: Y.encodeStateAsUpdate(doc) };
};
const settle = () => new Promise((r) => setTimeout(r, 500));

describe('the web app offline', () => {
  it('keeps what it opens and edits, and opens it from here next time', async () => {
    const { store, docs } = memoryStore();
    const first = fakeClient();
    const docsA = new OfflineDocs(
      store,
      () => first.client,
      () => {},
    );
    const opening = docsA.open('page');
    await Promise.resolve();
    await Promise.resolve();
    const server = edit(null, 'From the server. ');
    first.opens.get('page')!.resolve(server.state);
    expect(text(await opening)).toBe('From the server. ');
    docsA.push('page', edit(server.state, 'Typed here.').update);
    await settle();
    expect(text(docs.get('page')!)).toBe('From the server. Typed here.');

    // Next time (no server): it opens at once from here.
    const second = fakeClient();
    const shown: Uint8Array[] = [];
    const docsB = new OfflineDocs(
      store,
      () => second.client,
      (_, u) => shown.push(u),
    );
    expect(text(await docsB.open('page'))).toBe('From the server. Typed here.');
    // The server's copy, when it answers, merges in.
    second.opens.get('page')!.resolve(server.state);
    await Promise.resolve();
    expect(shown).toHaveLength(1);
  });

  it('keeps unsent edits, sends them again on the next start, forgets refused docs', async () => {
    const { store, kept, docs } = memoryStore();
    const { client, pushed, opens } = fakeClient();
    const offline = new OfflineDocs(
      store,
      () => client,
      () => {},
    );
    const items = [
      { localId: 1, docId: 'page', update: new Uint8Array([1]), scope: 'team' },
    ] as PushItem[];
    offline.pending(items);
    await settle();
    expect(kept.get('outbox')).toEqual(items);
    await offline.restore();
    expect(pushed).toEqual([{ docId: 'page', scope: 'team' }]);

    docs.set('gone', edit(null, 'Old').state);
    void offline.open('gone');
    await Promise.resolve();
    await Promise.resolve();
    opens.get('gone')!.reject(new NoAccessError('gone'));
    await settle();
    expect(docs.has('gone')).toBe(false);
  });
});
