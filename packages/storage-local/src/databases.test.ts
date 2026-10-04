import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  WORKSPACE_DOC_ID,
  createPage,
  deletePagePermanently,
  getPageContent,
  trashPage,
  upsertUser,
} from '@workspace/core';
import {
  addOption,
  addRow,
  deleteRow,
  initDatabase,
  readDatabase,
  readRow,
  rowsMap,
  setCell,
  trashRow,
} from '@workspace/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { DocManager, MIGRATIONS, SqliteStore } from './index';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ws-db-'));
  dbPath = join(dir, 'workspace.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

function setup() {
  const store = new SqliteStore(dbPath);
  const manager = new DocManager(store);
  const ws = connectWindow(manager, WORKSPACE_DOC_ID, 'w1');
  upsertUser(ws, { id: 'u1', name: 'Ravi' });
  const dbId = createPage(ws, { title: 'Parts', kind: 'database' });
  const db = connectWindow(manager, dbId, 'w1');
  initDatabase(db, { databaseId: dbId });
  return { store, manager, ws, dbId, db };
}

describe('database indexing', () => {
  it('indexes rows with their property text, and finds rows by content', () => {
    const { store, manager, ws, dbId, db } = setup();
    const tags = readDatabase(db).properties[1]!.id;
    addOption(db, tags, { id: 'act', name: 'Actuator', color: 'red' });
    const row = addRow(db, { actor: 'u1', title: 'Servo MG996R', values: { [tags]: ['act'] } });
    manager.flush();

    expect(store.locatePage(row)).toEqual({ databaseId: dbId });
    expect(store.locatePage(dbId)).toEqual({ databaseId: null });
    expect(store.locatePage('nope')).toBeNull();
    expect(store.search('servo')).toMatchObject([{ id: row, databaseId: dbId }]);
    expect(store.search('actuator').map((r) => r.id)).toEqual([row]);

    const content = connectWindow(manager, row, 'w1');
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('Stall torque 13 kg·cm')]);
    getPageContent(content).push([p]);
    manager.flush();
    expect(store.search('torque').map((r) => r.id)).toEqual([row]);
    // Editing the content stamps the row's "last edited" time in the database doc.
    expect(readRow(rowsMap(db).get(row)!).updatedAt).toBeGreaterThan(0);

    setCell(db, row, tags, null, 'u1');
    manager.flush();
    expect(store.search('actuator')).toEqual([]);

    trashRow(db, row);
    manager.flush();
    expect(store.search('servo')).toEqual([]);

    // A trashed database hides its rows from search too.
    const other = addRow(db, { actor: 'u1', title: 'Gearbox' });
    manager.flush();
    expect(store.search('gearbox').map((r) => r.id)).toEqual([other]);
    trashPage(ws, dbId);
    manager.flush();
    expect(store.search('gearbox')).toEqual([]);
    manager.close();
    store.close();
  });

  it('drops content docs of deleted rows and of deleted databases', () => {
    const { store, manager, ws, dbId, db } = setup();
    const a = addRow(db, { actor: null, title: 'A' });
    const b = addRow(db, { actor: null, title: 'B' });
    manager.flush();
    for (const id of [a, b]) {
      const content = connectWindow(manager, id, 'w1');
      getPageContent(content).push([new Y.XmlElement('paragraph')]);
      manager.release(id);
    }
    manager.flush();
    expect(store.getUpdates(a).length).toBeGreaterThan(0);

    deleteRow(db, a);
    manager.flush();
    expect(store.getUpdates(a)).toEqual([]);
    expect(store.locatePage(a)).toBeNull();

    deletePagePermanently(ws, dbId);
    manager.flush();
    expect(store.getUpdates(b)).toEqual([]);
    expect(store.locatePage(b)).toBeNull();
    expect(store.getUpdates(dbId)).toEqual([]);
    manager.close();
    store.close();
  });

  it('migrates a version 3 (Phase 1) file, keeping indexed text', () => {
    const raw = new DatabaseSync(dbPath);
    for (const sql of MIGRATIONS.slice(0, 3)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 3');
    raw.exec(`INSERT INTO pages VALUES ('p1', NULL, 'Old page', NULL, 'a0', 0, 1, 1)`);
    raw.exec(`INSERT INTO page_fts (page_id, title, body) VALUES ('p1', 'Old page', 'legacy')`);
    raw.close();

    const store = new SqliteStore(dbPath);
    expect(store.search('legacy')).toMatchObject([{ id: 'p1', databaseId: null }]);
    expect(store.locatePage('p1')).toEqual({ databaseId: null });
    store.close();
  });
});
