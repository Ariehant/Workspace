import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_DOC_ID, createPage, getPageContent } from '@workspace/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocManager, SqliteStore } from './index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-history-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function connect(manager: DocManager, docId: string, name: string) {
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
const paragraph = (s: string, id: string) => {
  const el = new Y.XmlElement('paragraph');
  el.setAttribute('id', id);
  el.insert(0, [new Y.XmlText(s)]);
  return el;
};
const mention = (pageId: string, id: string) => {
  const p = new Y.XmlElement('paragraph');
  p.setAttribute('id', id);
  const m = new Y.XmlElement('mention');
  m.setAttribute('kind', 'page');
  m.setAttribute('pageId', pageId);
  p.insert(0, [new Y.XmlText('see '), m]);
  return p;
};
const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return getPageContent(doc).toString();
};

describe('backlinks', () => {
  it('follow mentions as pages are edited, trashed and deleted', () => {
    const store = new SqliteStore(join(dir, 'w.db'));
    const manager = new DocManager(store);
    const ws = connect(manager, WORKSPACE_DOC_ID, 'w1');
    const target = createPage(ws, { title: 'Gripper' });
    const a = createPage(ws, { title: 'Arm' });
    const page = connect(manager, a, 'w1');
    getPageContent(page).insert(0, [mention(target, 'b1')]);
    manager.flush();
    const kinds = ['mention', 'link', 'pageLink', 'relation'];
    expect(store.backlinks(target, kinds)).toMatchObject([
      { id: a, title: 'Arm', blockId: 'b1', kind: 'mention', snippet: 'see @' },
    ]);
    getPageContent(page).delete(0, 1);
    manager.flush();
    expect(store.backlinks(target, kinds)).toEqual([]);
    store.close();
  });
});

describe('page history', () => {
  it('saves a version before each editing session, and on demand', () => {
    let now = 1_000_000;
    const store = new SqliteStore(join(dir, 'w.db'));
    const manager = new DocManager(store, { versionIntervalMs: 60_000, now: () => now });
    const ws = connect(manager, WORKSPACE_DOC_ID, 'w1');
    const id = createPage(ws, { title: 'Notes' });
    const page = connect(manager, id, 'w1');
    getPageContent(page).insert(0, [paragraph('first', 'a')]);
    // An empty page has nothing to save.
    expect(manager.versions(id)).toEqual([]);
    now += 10_000;
    getPageContent(page).insert(1, [paragraph('second', 'b')]);
    expect(manager.versions(id)).toHaveLength(1);
    now += 10_000;
    getPageContent(page).insert(2, [paragraph('third', 'c')]);
    expect(manager.versions(id)).toHaveLength(1); // same session
    now += 120_000;
    getPageContent(page).insert(3, [paragraph('fourth', 'd')]);
    const versions = manager.versions(id);
    expect(versions).toHaveLength(2);
    expect(textOf(manager.versionState(versions[1]!.id)!)).toContain('first');
    expect(textOf(manager.versionState(versions[1]!.id)!)).not.toContain('second');
    expect(textOf(manager.versionState(versions[0]!.id)!)).toContain('third');
    expect(manager.snapshot(id, 'restore')).toBeTypeOf('number');
    expect(manager.versions(id)[0]).toMatchObject({ reason: 'restore' });
    store.close();
  });

  it('keeps a week of versions, then one a day for 90 days', () => {
    const store = new SqliteStore(join(dir, 'w.db'));
    const day = 86_400_000;
    const now = 200 * day;
    const state = new Uint8Array([0, 0]);
    for (const t of [
      now - 1 * day,
      now - 2 * day,
      now - 10 * day + 1000,
      now - 10 * day + 5000,
      now - 100 * day,
    ]) {
      store.addVersion('p', state, 'edit', t);
    }
    expect(store.pruneVersions(now)).toBe(2);
    expect(store.listVersions('p').map((v) => (now - v.createdAt) / day)).toEqual([
      1,
      2,
      10 - 5000 / day,
    ]);
    store.close();
  });
});
