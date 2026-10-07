import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SyncHub } from './hub';
import { MemoryLogStore } from './memory';
import { PartialClient } from './partial';
import { TestNet, seeded, until } from './test-net';
import { Replica, contents } from './test-replica';

const WS = 'ws';

/** A browser tab: a Y.Doc per open doc, wired to a PartialClient. */
function tab(net: TestNet, id: string) {
  const docs = new Map<string, Y.Doc>();
  const REMOTE = Symbol('remote');
  const client = new PartialClient({
    connect: net.connector(id, WS),
    deviceId: id,
    backoff: { minMs: 1, maxMs: 10 },
    onUpdate: (docId, update) => {
      const doc = docs.get(docId);
      if (doc) Y.applyUpdate(doc, update, REMOTE);
    },
  });
  const open = async (docId: string) => {
    const doc = new Y.Doc();
    docs.set(docId, doc);
    Y.applyUpdate(doc, await client.open(docId), REMOTE);
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== REMOTE) client.push(docId, update);
    });
    return doc;
  };
  return { client, docs, open };
}

describe('PartialClient', () => {
  it('opens docs, sends edits, and gets the others’ edits live', async () => {
    const store = new MemoryLogStore();
    const net = new TestNet(new SyncHub(store));
    const desktop = new Replica('desk', net, WS, Math.random);
    desktop.client.start();
    desktop.doc('page').getText('t').insert(0, 'from desktop');
    await until(() => desktop.outbox.length === 0, 5000, 'desktop uploaded');

    const web = tab(net, 'web');
    web.client.start();
    const page = await web.open('page');
    expect(contents(page).t).toBe('from desktop');
    // A doc nobody wrote yet opens empty.
    expect(contents(await web.open('new')).t).toBe('');

    page.getText('t').insert(0, 'web: ');
    await until(
      () => desktop.doc('page').getText('t').toString() === 'web: from desktop',
      5000,
      'desk got it',
    );
    expect(web.client.unsent).toBe(0);
    desktop.doc('page').getText('t').insert(0, '! ');
    await until(() => page.getText('t').toString() === '! web: from desktop', 5000, 'web got it');

    // A closed doc's updates aren't sent to the tab.
    web.client.close('new');
    desktop.doc('new').getText('t').insert(0, 'later');
    await until(() => desktop.outbox.length === 0, 5000, 'stored');
    expect(contents(web.docs.get('new')!).t).toBe('');
    web.client.stop();
    desktop.client.stop();
  });

  it('resends unacknowledged edits and catches up after reconnecting', async () => {
    const rng = seeded(7);
    const store = new MemoryLogStore();
    const net = new TestNet(new SyncHub(store), rng);
    const desktop = new Replica('desk', net, WS, rng);
    const web = tab(net, 'web');
    desktop.client.start();
    web.client.start();
    const page = await web.open('page');

    // Offline: the tab edits, and so does the desktop.
    net.offline.add('web');
    for (const link of net.linksOf('web')) link.cut();
    await until(() => web.client.state.state === 'offline', 5000, 'offline');
    page.getText('t').insert(0, 'offline web edit. ');
    expect(web.client.unsent).toBeGreaterThan(0);
    desktop.doc('page').getText('t').insert(0, 'desktop edit. ');

    net.offline.delete('web');
    web.client.retryNow();
    await until(
      () =>
        web.client.unsent === 0 &&
        page.getText('t').toString() === desktop.doc('page').getText('t').toString() &&
        page.getText('t').length > 30,
      5000,
      'converged',
    );
    expect(web.client.state.state).toBe('live');
    web.client.stop();
    desktop.client.stop();
  });

  it('survives dropped and duplicated messages', async () => {
    const rng = seeded(3);
    const store = new MemoryLogStore();
    const net = new TestNet(new SyncHub(store), rng);
    net.duplicate = 0.1;
    const desktop = new Replica('desk', net, WS, rng);
    const web = tab(net, 'web');
    desktop.client.start();
    web.client.start();
    const page = await web.open('page');
    for (let i = 0; i < 60; i++) {
      if (i % 2) page.getText('t').insert(0, `w${i} `);
      else desktop.doc('page').getText('t').insert(0, `d${i} `);
      if (i % 15 === 7) for (const link of net.linksOf('web')) link.cut();
      await new Promise((r) => setTimeout(r, 1));
    }
    net.duplicate = 0;
    await until(
      () =>
        web.client.unsent === 0 &&
        desktop.outbox.length === 0 &&
        page.getText('t').toString() === desktop.doc('page').getText('t').toString(),
      10_000,
      'converged',
    );
    expect(page.getText('t').toString().split(' ').filter(Boolean)).toHaveLength(60);
    web.client.stop();
    desktop.client.stop();
  });
});
