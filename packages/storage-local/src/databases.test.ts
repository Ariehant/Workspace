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
  addProperty,
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

  it('migrates a version 6 file: entries find their full-text rows', () => {
    const raw = new DatabaseSync(dbPath);
    for (const sql of MIGRATIONS.slice(0, 6)) raw.exec(sql);
    raw.exec('PRAGMA user_version = 6');
    raw.exec(`INSERT INTO pages (id, parent_id, database_id, title, icon, sort_key, in_trash,
      created_at, updated_at) VALUES ('r1', 'db', 'db', 'Gearbox', NULL, 'a0', 0, 1, 1)`);
    raw.exec(`INSERT INTO page_fts (page_id, title, body, props)
      VALUES ('r1', 'Gearbox', 'notes', 'steel')`);
    raw.close();

    const store = new SqliteStore(dbPath);
    expect(store.search('steel')).toMatchObject([{ id: 'r1', databaseId: 'db' }]);
    const row = { id: 'r1', title: 'Gearbox v2', icon: null, sortKey: 'a0', inTrash: false };
    store.syncRowIndex('db', [{ ...row, createdAt: 1, updatedAt: 2, props: 'aluminium' }]);
    store.setPageBody('r1', 'revised notes');
    // The same full-text row, changed: one result, with the new text.
    expect(store.search('Gearbox')).toMatchObject([{ id: 'r1', title: 'Gearbox v2' }]);
    expect(store.search('steel')).toEqual([]);
    expect(store.search('aluminium revised')).toHaveLength(1);
    store.syncRowIndex('db', []);
    expect(store.search('Gearbox')).toEqual([]);
    store.close();
  });

  it('writes only the rows that changed', () => {
    const { store, manager, db } = setup();
    const status = addProperty(db, { name: 'Status', type: 'text' });
    const ids = Array.from({ length: 50 }, (_, i) =>
      addRow(db, { actor: null, title: `Row ${i}` }),
    );
    manager.flush();
    const changes = () =>
      (store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const before = changes();
    setCell(db, ids[7]!, status, 'shipped', null);
    manager.flush();
    // The row's entry and its full-text row, not all 50 rows (two writes each).
    expect(changes() - before).toBeLessThan(20);
    expect(store.search('shipped').map((r) => r.id)).toEqual([ids[7]]);
    manager.close();
    store.close();
  });
});

describe('date property reminders', () => {
  it('are indexed per row, apart from content reminders, and survive re-indexing once fired', () => {
    const { store, manager, db } = setup();
    const due = addProperty(db, { name: 'Due', type: 'date' });
    const row = addRow(db, {
      actor: null,
      title: 'Ship',
      values: { [due]: { start: '2026-10-20', reminder: 'onDay' } },
    });
    manager.flush();
    const at = new Date(2026, 9, 20, 9).getTime();
    expect(store.dueReminders(at)).toMatchObject([
      { pageId: row, pageTitle: 'Ship', text: 'Due: Ship', fireAt: at },
    ]);

    // Content reminders on the row's page don't replace the property's.
    store.replaceReminders(row, [{ blockId: 'b1', fireAt: at, text: 'From content' }]);
    expect(store.dueReminders(at)).toHaveLength(2);
    // Home's Upcoming: still to come, soonest first; a property's reminder is at no block.
    expect(
      store
        .upcomingReminders(at - 1, 10)
        .map((r) => [r.blockId, r.text])
        .sort(),
    ).toEqual([
      [null, 'Due: Ship'],
      ['b1', 'From content'],
    ]);
    expect(store.upcomingReminders(at + 1, 10)).toEqual([]);
    expect(store.upcomingReminders(at - 1, 1)).toHaveLength(1);

    store.markReminderFired({ pageId: row, blockId: `prop:${due}`, fireAt: at });
    setCell(db, row, due, { start: '2026-10-20', reminder: 'onDay' }, null);
    manager.flush();
    expect(store.dueReminders(at).map((r) => r.text)).toEqual(['From content']);
    // A reminder that fired isn't upcoming.
    expect(store.upcomingReminders(at - 1, 10).map((r) => r.text)).toEqual(['From content']);

    setCell(db, row, due, { start: '2026-10-21' }, null);
    manager.flush();
    expect(store.dueReminders(at + 2 * 86_400_000).map((r) => r.text)).toEqual(['From content']);
    manager.close();
    store.close();
  });
});

describe('row dates (Meetings)', () => {
  it('lists rows with a date in a range, soonest first, following edits and the trash', () => {
    const { store, manager, db, dbId } = setup();
    const when = addProperty(db, { name: 'When', type: 'date' });
    const standup = addRow(db, {
      actor: null,
      title: 'Standup',
      values: { [when]: { start: '2026-12-01T09:30' } },
    });
    const trip = addRow(db, {
      actor: null,
      title: 'Trip',
      values: { [when]: { start: '2026-11-30', end: '2026-12-02' } },
    });
    addRow(db, { actor: null, title: 'Later', values: { [when]: { start: '2026-12-20' } } });
    addRow(db, { actor: null, title: 'Undated', values: {} });
    manager.flush();

    const titles = (from: string, to: string) =>
      store.upcomingEvents(from, to, 50).map((e) => e.title);
    // A trip that started before the range and goes on into it is listed.
    expect(titles('2026-12-01', '2026-12-08')).toEqual(['Trip', 'Standup']);
    expect(store.upcomingEvents('2026-12-01', '2026-12-08', 50)[1]).toMatchObject({
      rowId: standup,
      databaseId: dbId,
      databaseTitle: 'Parts',
      propertyId: when,
      start: '2026-12-01T09:30',
      allDay: false,
    });
    expect(titles('2026-12-03', '2026-12-08')).toEqual([]);

    // Moved, then trashed.
    setCell(db, standup, when, { start: '2026-12-05T10:00' }, null);
    manager.flush();
    expect(titles('2026-12-01', '2026-12-08')).toEqual(['Trip', 'Standup']);
    expect(titles('2026-12-03', '2026-12-08')).toEqual(['Standup']);
    trashRow(db, trip);
    manager.flush();
    expect(titles('2026-12-01', '2026-12-08')).toEqual(['Standup']);
    manager.close();
    store.close();
  });

  it('indexes the dates of databases indexed before (a first pass, once)', () => {
    const { store, manager, db } = setup();
    const when = addProperty(db, { name: 'When', type: 'date' });
    addRow(db, { actor: null, title: 'Review', values: { [when]: { start: '2026-12-01' } } });
    manager.flush();
    manager.close();
    // As a workspace from before Meetings: the dates' index is empty.
    store.db.exec('DELETE FROM row_dates');
    store.close();

    const reopened = new SqliteStore(dbPath);
    const again = new DocManager(reopened);
    expect(reopened.upcomingEvents('2026-12-01', '2026-12-02', 10)).toEqual([]);
    again.indexRowDatesOnce();
    expect(reopened.upcomingEvents('2026-12-01', '2026-12-02', 10).map((e) => e.title)).toEqual([
      'Review',
    ]);
    expect(reopened.hasRowDatesIndex()).toBe(true);
    again.close();
    reopened.close();
  });
});
