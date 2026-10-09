import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addRow,
  addView,
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
