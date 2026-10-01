import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocClient, type DocTransport } from './index';

/** In-memory stand-in for the main process: one stored doc per id, fan-out to clients. */
class FakeHost {
  docs = new Map<string, Y.Doc>();
  clients: { listener: (id: string, u: Uint8Array) => void }[] = [];
  closed: string[] = [];

  doc(id: string) {
    let doc = this.docs.get(id);
    if (!doc) this.docs.set(id, (doc = new Y.Doc()));
    return doc;
  }

  transport(): DocTransport {
    const self = { listener: (_id: string, _u: Uint8Array) => {} };
    this.clients.push(self);
    return {
      open: async (id) => Y.encodeStateAsUpdate(this.doc(id)),
      push: (id, update) => {
        Y.applyUpdate(this.doc(id), update);
        for (const c of this.clients) if (c !== self) c.listener(id, update);
      },
      subscribe: (listener) => {
        self.listener = listener;
        return () => {
          self.listener = () => {};
        };
      },
      close: (id) => this.closed.push(id),
    };
  }
}

describe('DocClient', () => {
  it('loads stored state and pushes local edits', async () => {
    const host = new FakeHost();
    host.doc('p1').getText('t').insert(0, 'stored');
    const client = new DocClient(host.transport());

    const handle = client.acquire('p1');
    await handle.ready;
    expect(handle.doc.getText('t').toString()).toBe('stored');

    handle.doc.getText('t').insert(6, ' + local');
    expect(host.doc('p1').getText('t').toString()).toBe('stored + local');
  });

  it('relays edits between two windows without echoing', async () => {
    const host = new FakeHost();
    const w1 = new DocClient(host.transport()).acquire('p1');
    const w2 = new DocClient(host.transport()).acquire('p1');
    await Promise.all([w1.ready, w2.ready]);

    w1.doc.getText('t').insert(0, 'hi');
    expect(w2.doc.getText('t').toString()).toBe('hi');
    w2.doc.getText('t').insert(2, '!');
    expect(w1.doc.getText('t').toString()).toBe('hi!');
    expect(host.doc('p1').getText('t').toString()).toBe('hi!');
  });

  it('shares one doc per id and closes it after the last release', async () => {
    const host = new FakeHost();
    const client = new DocClient(host.transport());
    const a = client.acquire('p1');
    const b = client.acquire('p1');
    expect(a.doc).toBe(b.doc);

    a.release();
    a.release();
    expect(host.closed).toEqual([]);
    b.release();
    expect(host.closed).toEqual(['p1']);

    const c = client.acquire('p1');
    expect(c.doc).not.toBe(a.doc);
  });
});
