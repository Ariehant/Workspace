import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_DOC_ID,
  createPage,
  deletePagePermanently,
  getPage,
  getPageContent,
  setPageTitle,
  trashPage,
} from '@workspace/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocManager, MAIN_ORIGIN, SqliteStore } from './index';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-store-'));
  dbPath = join(dir, 'workspace.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Simulates a renderer window: edits a local doc and ships updates to the manager. */
function connectWindow(manager: DocManager, docId: string, name: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, manager.open(docId), 'load');
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote' && origin !== 'load') manager.applyUpdate(docId, update, name);
  });
  manager.onUpdate((id, update, origin) => {
    if (id === docId && origin !== name) Y.applyUpdate(doc, update, 'remote');
  });
  return doc;
}

function writeParagraph(doc: Y.Doc, text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  getPageContent(doc).push([p]);
}

describe('SqliteStore', () => {
  it('migrates once and keeps settings', () => {
    const store = new SqliteStore(dbPath);
    store.setSetting('theme', 'dark');
    store.setSetting('lastPage', { id: 'p1' });
    store.close();

    const reopened = new SqliteStore(dbPath);
    expect(reopened.getSetting('theme')).toBe('dark');
    expect(reopened.getSetting('lastPage')).toEqual({ id: 'p1' });
    expect(reopened.getSetting('missing')).toBeUndefined();
    reopened.close();
  });

  it('stores and compacts update logs', () => {
    const store = new SqliteStore(dbPath);
    store.appendUpdate('d', new Uint8Array([1, 2]));
    store.appendUpdate('d', new Uint8Array([3]));
    expect(store.getUpdates('d')).toEqual([new Uint8Array([1, 2]), new Uint8Array([3])]);
    store.replaceUpdates('d', new Uint8Array([9]));
    expect(store.getUpdates('d')).toEqual([new Uint8Array([9])]);
    store.deleteDoc('d');
    expect(store.getUpdates('d')).toEqual([]);
    store.close();
  });
});

describe('DocManager', () => {
  it('persists pages and content across restarts', () => {
    let store = new SqliteStore(dbPath);
    let manager = new DocManager(store);
    const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const pageId = createPage(ws, { title: 'Roadmap' });
    const page = connectWindow(manager, pageId, 'w1');
    writeParagraph(page, 'Ship phase zero');
    manager.close();
    store.close();

    store = new SqliteStore(dbPath);
    manager = new DocManager(store);
    expect(getPage(manager.workspace, pageId)?.title).toBe('Roadmap');
    const reloaded = new Y.Doc();
    Y.applyUpdate(reloaded, manager.open(pageId));
    expect(getPageContent(reloaded).toString()).toBe('<paragraph>Ship phase zero</paragraph>');
    manager.close();
    store.close();
  });

  it('compacts long update logs on load', () => {
    const store = new SqliteStore(dbPath);
    let manager = new DocManager(store, { compactThreshold: 5 });
    const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const id = createPage(ws, { title: '' });
    for (let i = 0; i < 20; i++) setPageTitle(ws, id, `Title ${i}`);
    manager.close();
    expect(store.getUpdates(WORKSPACE_DOC_ID).length).toBeGreaterThan(5);

    manager = new DocManager(store, { compactThreshold: 5 });
    expect(store.getUpdates(WORKSPACE_DOC_ID)).toHaveLength(1);
    expect(getPage(manager.workspace, id)?.title).toBe('Title 19');
    manager.close();
    store.close();
  });

  it('relays edits between windows', () => {
    const store = new SqliteStore(dbPath);
    const manager = new DocManager(store);
    const w1 = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const w2 = connectWindow(manager, WORKSPACE_DOC_ID, 'w2');
    const id = createPage(w1, { title: 'Shared' });
    expect(getPage(w2, id)?.title).toBe('Shared');
    manager.close();
    store.close();
  });

  it('indexes titles and content for search, hiding trashed pages', () => {
    const store = new SqliteStore(dbPath);
    const manager = new DocManager(store);
    const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const a = createPage(ws, { title: 'Robot arm calibration' });
    const b = createPage(ws, { title: 'Grocery list' });
    const page = connectWindow(manager, b, 'w1');
    writeParagraph(page, 'Buy servo motors and café crème');
    manager.flush();

    expect(store.search('calib').map((r) => r.id)).toEqual([a]);
    expect(store.search('servo').map((r) => r.id)).toEqual([b]);
    expect(store.search('cafe creme')[0]?.snippet).toContain('[café]');
    expect(store.search('!!!')).toEqual([]);

    trashPage(ws, b);
    manager.flush();
    expect(store.search('servo')).toEqual([]);
    expect(store.getPageIndex(b)?.inTrash).toBe(true);
    manager.close();
    store.close();
  });

  it('stamps updatedAt when page content changes, without echoing to the editor', () => {
    const store = new SqliteStore(dbPath);
    const manager = new DocManager(store);
    const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const id = createPage(ws, { title: 'Log', now: 1 });
    const page = connectWindow(manager, id, 'w1');
    const origins: unknown[] = [];
    manager.onUpdate((docId, _u, origin) => docId === WORKSPACE_DOC_ID && origins.push(origin));

    writeParagraph(page, 'entry');
    manager.flush();
    expect(getPage(ws, id)!.updatedAt).toBeGreaterThan(1);
    expect(origins).toEqual([MAIN_ORIGIN]);
    manager.close();
    store.close();
  });

  it('drops page docs when pages are deleted permanently', () => {
    const store = new SqliteStore(dbPath);
    const manager = new DocManager(store);
    const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
    const id = createPage(ws, { title: 'Temp' });
    writeParagraph(connectWindow(manager, id, 'w1'), 'scratch');
    manager.flush();
    expect(store.getUpdates(id).length).toBeGreaterThan(0);

    deletePagePermanently(ws, id);
    manager.flush();
    expect(store.getUpdates(id)).toEqual([]);
    expect(store.getPageIndex(id)).toBeNull();
    manager.close();
    store.close();
  });
});
