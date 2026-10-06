import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKSPACE_DOC_ID,
  createPage,
  getPageContent,
  setSyncedSource,
  syncedBlockIds,
  syncedSource,
} from '@workspace/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocManager, SqliteStore } from './index';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-synced-'));
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

const paragraph = (text: string) => {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, [new Y.XmlText(text)]);
  return el;
};
const synced = (id: string) => {
  const el = new Y.XmlElement('syncedBlock');
  el.setAttribute('syncedId', id);
  return el;
};

describe('synced blocks', () => {
  it('pages list the synced blocks they show; the content doc knows its source', () => {
    const doc = new Y.Doc();
    getPageContent(doc).insert(0, [paragraph('a'), synced('s1'), synced('s2'), synced('s1')]);
    expect(syncedBlockIds(doc)).toEqual(['s1', 's2']);
    const content = new Y.Doc();
    expect(syncedSource(content)).toBeNull();
    setSyncedSource(content, 'page-1');
    expect(syncedSource(content)).toBe('page-1');
  });

  it('their content is searchable on every page that shows them, and follows edits', () => {
    const store = new SqliteStore(join(dir, 'workspace.db'));
    const manager = new DocManager(store);
    const ws = connect(manager, WORKSPACE_DOC_ID, 'w1');
    const a = createPage(ws, { title: 'Arm notes' });
    const b = createPage(ws, { title: 'Base notes' });
    const content = connect(manager, 's1', 'w1');
    getPageContent(content).insert(0, [paragraph('servo torque limits')]);
    for (const id of [a, b]) {
      const page = connect(manager, id, 'w1');
      getPageContent(page).insert(0, [paragraph('intro'), synced('s1')]);
    }
    manager.flush();
    expect(
      store
        .search('torque')
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, b].sort());

    const text = getPageContent(content).get(0) as Y.XmlElement;
    (text.get(0) as Y.XmlText).insert(0, 'gearbox ');
    manager.flush();
    expect(
      store
        .search('gearbox')
        .map((r) => r.id)
        .sort(),
    ).toEqual([a, b].sort());
    store.close();
  });
});
