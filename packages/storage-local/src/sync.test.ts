import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_DOC_ID,
  createPage,
  getPageContent,
  listPages,
  setPageTitle,
} from '@workspace/core';
import { MemoryLogStore, SyncClient, SyncHub } from '@workspace/sync';
import { TestNet, until } from '@workspace/sync/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  DocManager,
  FileStore,
  LocalSyncStore,
  MAIN_ORIGIN,
  SYNC_CURSOR,
  SYNC_ORIGIN,
  SqliteStore,
  backupEntries,
  restoreBackup,
} from './index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-sync-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const paragraph = (text: string) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};
/** An edit to a page doc, as a window would send it. */
function write(manager: DocManager, pageId: string, text: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(pageId));
  const before = Y.encodeStateVector(doc);
  getPageContent(doc).insert(getPageContent(doc).length, [paragraph(text)]);
  manager.applyUpdate(pageId, Y.encodeStateAsUpdate(doc, before), 'window-1');
  manager.release(pageId);
}
function read(manager: DocManager, pageId: string): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(pageId));
  manager.release(pageId);
  return getPageContent(doc)
    .toArray()
    .map((el) => (el as Y.XmlElement).toArray().join(''))
    .join('|');
}
/** Change the workspace doc (page tree) as a window would. */
function editWorkspace(manager: DocManager, fn: (ws: Y.Doc) => void) {
  const ws = new Y.Doc();
  Y.applyUpdate(ws, manager.open(WORKSPACE_DOC_ID));
  const before = Y.encodeStateVector(ws);
  fn(ws);
  manager.applyUpdate(WORKSPACE_DOC_ID, Y.encodeStateAsUpdate(ws, before), 'window-1');
}

describe('outbox', () => {
  it('queues local changes only while sync is on, never the server’s', () => {
    const store = new SqliteStore(join(dir, 'a.db'));
    const manager = new DocManager(store, { indexDelayMs: 0 });
    write(manager, 'p1', 'before sync');
    expect(store.outboxCount()).toBe(0);

    manager.setOutbox(true);
    write(manager, 'p1', 'local');
    expect(store.outboxPending(10).map((e) => e.docId)).toEqual(['p1']);

    // Changes the manager makes itself (e.g. "last edited") are local changes too.
    editWorkspace(manager, (ws) => createPage(ws, { title: 'T' }));
    manager.workspace.transact(() => manager.workspace.getMap('x').set('k', 1), MAIN_ORIGIN);
    const count = store.outboxCount();
    expect(count).toBeGreaterThanOrEqual(3);

    // From the server: applied and stored, not queued.
    const remote = new Y.Doc();
    getPageContent(remote).insert(0, [paragraph('remote')]);
    manager.applyUpdate('p2', Y.encodeStateAsUpdate(remote), SYNC_ORIGIN);
    expect(store.outboxCount()).toBe(count);
    expect(read(manager, 'p2')).toBe('remote');

    const ids = store.outboxPending(100).map((e) => e.localId);
    store.outboxRemove(ids.slice(0, 2));
    expect(store.outboxCount()).toBe(count - 2);
    manager.close();
    store.close();
  });

  it('queues the full state of every doc when a workspace starts syncing', () => {
    const store = new SqliteStore(join(dir, 'a.db'));
    const manager = new DocManager(store, { indexDelayMs: 0 });
    let page = '';
    editWorkspace(manager, (ws) => (page = createPage(ws, { title: 'Arm' })));
    write(manager, page, 'one');
    write(manager, page, 'two');
    expect(manager.queueFullState()).toBe(2);
    const entries = store.outboxPending(10);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, entries.find((e) => e.docId === page)!.update);
    expect(getPageContent(doc).length).toBe(2);
    manager.close();
    store.close();
  });

  it('keeps sync settings (the token) out of backups', () => {
    const store = new SqliteStore(join(dir, 'a.db'));
    store.setSetting('sync.token', 'secret');
    store.setSetting(SYNC_CURSOR, 5);
    store.setSetting('ui.theme', 'dark');
    const entries = new Map<string, Uint8Array>();
    for (const entry of backupEntries(store, join(dir, 'files')))
      entries.set(entry.path, entry.data);
    expect(new TextDecoder().decode(entries.get('settings.json'))).not.toContain('secret');

    // An old backup that carried them: they're not restored.
    entries.set(
      'settings.json',
      new TextEncoder().encode(JSON.stringify({ 'sync.token': 'old', 'ui.theme': 'light' })),
    );
    const fresh = new SqliteStore(join(dir, 'b.db'));
    restoreBackup(entries, fresh, join(dir, 'files-b'));
    expect(fresh.getSetting('sync.token')).toBeUndefined();
    expect(fresh.getSetting('ui.theme')).toBe('light');
    store.close();
    fresh.close();
  });

  it('accepts downloaded attachments only when their hash matches', () => {
    const store = new SqliteStore(join(dir, 'a.db'));
    const files = new FileStore(dir, store);
    const bytes = new TextEncoder().encode('robot arm');
    const { id } = new FileStore(join(dir, 'other'), new SqliteStore(join(dir, 'o.db'))).import(
      bytes,
      'arm.txt',
      'text/plain',
    );
    expect(files.importAs(id, new TextEncoder().encode('tampered'), 'arm.txt', 'text/plain')).toBe(
      false,
    );
    expect(files.resolve(id)).toBeNull();
    expect(files.importAs(id, bytes, 'arm.txt', 'text/plain')).toBe(true);
    expect(files.resolve(id)).not.toBeNull();
    expect(store.getFileRecord(id)?.name).toBe('arm.txt');
    expect(store.unsyncedFiles().map((f) => f.id)).toEqual([id]);
    expect(store.unsyncedFileCount()).toBe(1);
    store.markFileSynced(id);
    expect(store.unsyncedFiles()).toEqual([]);
    expect(store.unsyncedFileCount()).toBe(0);
    store.close();
  });
});

describe('two devices through a hub', () => {
  /** A device: its own database and DocManager, syncing through `net`. */
  function device(name: string, net: TestNet) {
    const path = join(dir, `${name}.db`);
    let store = new SqliteStore(path);
    let manager = new DocManager(store, { indexDelayMs: 0 });
    manager.setOutbox(true);
    const forwarded: string[] = [];
    const makeClient = () => {
      const client = new SyncClient({
        store: new LocalSyncStore(store, manager),
        deviceId: name,
        connect: net.connector(name, 'ws'),
        backoff: { minMs: 1, maxMs: 10 },
      });
      // Windows see the server's changes like any other (the IPC fan-out).
      manager.onUpdate((docId, _u, origin) => {
        if (origin === SYNC_ORIGIN) forwarded.push(docId);
      });
      manager.onUpdate((_d, _u, origin) => {
        if (origin !== SYNC_ORIGIN) client.flush();
      });
      return client;
    };
    let client = makeClient();
    const d = {
      get store() {
        return store;
      },
      get manager() {
        return manager;
      },
      get client() {
        return client;
      },
      forwarded,
      /** Quit and start again on the same database. */
      restart() {
        client.stop();
        manager.close();
        store.close();
        store = new SqliteStore(path);
        manager = new DocManager(store, { indexDelayMs: 0 });
        manager.setOutbox(true);
        client = makeClient();
        client.start();
      },
    };
    return d;
  }

  it('syncs pages both ways, after offline edits and restarts', async () => {
    const server = new MemoryLogStore();
    const net = new TestNet(new SyncHub(server));
    const a = device('a', net);
    const b = device('b', net);

    // A has a workspace already; it starts syncing and uploads all of it.
    let page = '';
    editWorkspace(a.manager, (ws) => (page = createPage(ws, { title: 'Gripper' })));
    write(a.manager, page, 'Torque 2 Nm');
    a.manager.queueFullState();
    a.client.start();
    b.client.start();
    await until(() => a.store.outboxCount() === 0, 5000, 'A uploaded');
    await until(() => listPages(b.manager.workspace).length === 1, 5000, 'B has the page');
    expect(read(b.manager, page)).toBe('Torque 2 Nm');
    expect(b.forwarded).toContain(page);
    // What came from the server isn't queued to go back.
    expect(b.store.outboxCount()).toBe(0);
    expect(b.store.getSetting(SYNC_CURSOR)).toBe(await server.latest('ws'));
    // ...and it's indexed like any other page (search).
    await until(() => b.store.search('Torque').length === 1, 5000, 'B indexed it');

    // B goes offline and edits; A edits too; B quits while offline.
    net.offline.add('b');
    for (const link of net.linksOf('b')) link.cut();
    write(b.manager, page, 'B offline');
    editWorkspace(b.manager, (ws) => setPageTitle(ws, page, 'Gripper v2'));
    write(a.manager, page, 'A online');
    b.restart();
    expect(b.store.outboxCount()).toBeGreaterThan(0);
    net.offline.delete('b');
    b.client.retryNow();

    await until(
      () =>
        a.store.outboxCount() === 0 &&
        b.store.outboxCount() === 0 &&
        read(a.manager, page) === read(b.manager, page) &&
        read(a.manager, page).split('|').length === 3,
      5000,
      'converged',
    );
    expect(listPages(a.manager.workspace)[0]!.title).toBe('Gripper v2');
    a.client.stop();
    b.client.stop();
  }, 30_000);
});
