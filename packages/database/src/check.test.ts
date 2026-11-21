import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addRow,
  addView,
  checkOwnRowsChange,
  checkRowsOnlyChange,
  deleteRow,
  initDatabase,
  moveRow,
  readDatabase,
  renameProperty,
  setCell,
  setMeta,
  setRowTitle,
  trashRow,
  updateView,
} from './index';

const DB = 'db-1';

/** A database with one row, as the server has it, and a client's copy of it. */
function setup() {
  const server = new Y.Doc();
  initDatabase(server, { databaseId: DB });
  const rowId = addRow(server, { actor: 'ada', title: 'First' });
  const client = new Y.Doc();
  Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
  return { server, client, rowId };
}

/** What `change` on the client sends to the server. */
function changeOf(client: Y.Doc, change: (doc: Y.Doc) => void): Uint8Array {
  const before = Y.encodeStateVector(client);
  change(client);
  return Y.encodeStateAsUpdate(client, before);
}

describe('checkRowsOnlyChange', () => {
  it('allows adding, editing, reordering, trashing and deleting rows', () => {
    const { server, client, rowId } = setup();
    const tags = readDatabase(client).properties.find((p) => p.name === 'Tags')!;
    const changes = [
      (doc: Y.Doc) => addRow(doc, { actor: 'bob', title: 'Second' }),
      (doc: Y.Doc) => setRowTitle(doc, rowId, 'Renamed', 'bob'),
      (doc: Y.Doc) => setCell(doc, rowId, tags.id, [], 'bob'),
      (doc: Y.Doc) => moveRow(doc, rowId, null),
      (doc: Y.Doc) => trashRow(doc, rowId),
      (doc: Y.Doc) => deleteRow(doc, rowId),
    ];
    for (const change of changes) {
      const update = changeOf(client, change);
      expect(checkRowsOnlyChange(server, update)).toBeNull();
      Y.applyUpdate(server, update);
    }
  });

  it('refuses changes to properties, views and settings', () => {
    const { server, client } = setup();
    const view = readDatabase(client).views[0]!;
    const title = readDatabase(client).properties[0]!;
    const changes: [(doc: Y.Doc) => void, string][] = [
      [(doc) => addProperty(doc, { name: 'Status', type: 'status' }), 'changed "schema"'],
      [(doc) => renameProperty(doc, title.id, 'Task'), 'changed "schema"'],
      [(doc) => addView(doc, { viewSet: DB, name: 'Board', type: 'board' }), 'changed "views"'],
      [(doc) => updateView(doc, view.id, { name: 'All' }), 'changed "views"'],
      [(doc) => setMeta(doc, { description: 'Mine now' }), 'changed "meta"'],
      [(doc) => doc.getMap('elsewhere').set('x', 1), 'changed "elsewhere"'],
    ];
    for (const [change, reason] of changes) {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(client));
      expect(checkRowsOnlyChange(server, changeOf(copy, change))).toBe(reason);
    }
  });

  it('refuses a row edit bundled with a schema edit', () => {
    const { server, client, rowId } = setup();
    const update = changeOf(client, (doc) =>
      doc.transact(() => {
        setRowTitle(doc, rowId, 'Fine', 'bob');
        addProperty(doc, { name: 'Sneaky', type: 'text' });
      }),
    );
    expect(checkRowsOnlyChange(server, update)).toBe('changed "schema"');
  });

  it('refuses deleting a property (a deletion only)', () => {
    const { server, client } = setup();
    const tags = readDatabase(client).properties.find((p) => p.name === 'Tags')!;
    const update = changeOf(client, (doc) => doc.getMap('schema').delete(tags.id));
    expect(checkRowsOnlyChange(server, update)).toBe('changed "schema"');
  });

  it('refuses updates that depend on changes the server lacks, and garbage', () => {
    const { server, client, rowId } = setup();
    changeOf(client, (doc) => setRowTitle(doc, rowId, 'Unsent', 'bob'));
    const later = changeOf(client, (doc) => setRowTitle(doc, rowId, 'Later', 'bob'));
    expect(checkRowsOnlyChange(server, later)).toBe('depends on unknown changes');
    expect(checkRowsOnlyChange(server, new Uint8Array([1, 2, 3]))).toBe('malformed update');
  });
});

describe('checkOwnRowsChange ("can create pages")', () => {
  it('allows adding rows as themselves, then editing, moving, trashing and deleting them', () => {
    const { server, client } = setup();
    const tags = readDatabase(client).properties.find((p) => p.name === 'Tags')!;
    let mine = '';
    const changes = [
      (doc: Y.Doc) => void (mine = addRow(doc, { actor: 'bob', title: 'Request' })),
      (doc: Y.Doc) => setRowTitle(doc, mine, 'My request', 'bob'),
      (doc: Y.Doc) => setCell(doc, mine, tags.id, [], 'bob'),
      (doc: Y.Doc) => moveRow(doc, mine, null),
      (doc: Y.Doc) => trashRow(doc, mine),
      (doc: Y.Doc) => deleteRow(doc, mine),
    ];
    for (const change of changes) {
      const update = changeOf(client, change);
      expect(checkOwnRowsChange(server, update, 'bob')).toBeNull();
      Y.applyUpdate(server, update);
    }
  });

  it('refuses someone else’s rows, rows said to be someone else’s, and the database itself', () => {
    const { server, rowId } = setup();
    // Each change from a fresh copy of what the server has (none of them is applied).
    const check = (change: (doc: Y.Doc) => void) => {
      const client = new Y.Doc();
      Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
      return checkOwnRowsChange(server, changeOf(client, change), 'bob');
    };
    // Ada's row: not to be edited, trashed or deleted.
    expect(check((doc) => setRowTitle(doc, rowId, 'Mine now', 'bob'))).toMatch(/someone else/);
    expect(check((doc) => trashRow(doc, rowId))).toMatch(/someone else/);
    expect(check((doc) => deleteRow(doc, rowId))).toMatch(/someone else/);
    // A new row made in someone else's name, or no one's.
    expect(check((doc) => addRow(doc, { actor: 'ada', title: 'Fake' }))).toMatch(/not made by/);
    expect(check((doc) => addRow(doc, { actor: null, title: 'Nobody' }))).toMatch(/not made by/);
    // The database: properties and views, as for "can edit content".
    expect(check((doc) => addProperty(doc, { name: 'Cost', type: 'number' }))).toMatch(/changed "/);
  });

  it('refuses taking over a row by changing who made it', () => {
    const { server, client } = setup();
    const add = changeOf(client, (doc) => addRow(doc, { actor: 'bob', id: 'r2', title: 'Mine' }));
    Y.applyUpdate(server, add);
    const update = changeOf(client, (doc) => {
      const row = doc.getMap<Y.Map<unknown>>('rows').get('r2')!;
      row.set('createdBy', 'ada');
    });
    expect(checkOwnRowsChange(server, update, 'bob')).toMatch(/who made/);
  });
});
