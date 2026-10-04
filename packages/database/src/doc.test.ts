import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addOption,
  addProperty,
  addRow,
  changePropertyType,
  copyDatabase,
  deleteOption,
  deleteProperty,
  duplicateProperty,
  duplicateRow,
  emptyRowTrashBefore,
  initDatabase,
  isDatabaseDoc,
  moveRow,
  moveViewColumn,
  readDatabase,
  setCell,
  setRowTitle,
  trashRow,
  updateViewColumn,
  viewColumns,
} from './index';

const ctx = { users: new Map([['u1', 'Ravi']]) };

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  return doc;
}

const names = (doc: Y.Doc) => readDatabase(doc).properties.map((p) => p.name);
const titles = (doc: Y.Doc) => readDatabase(doc).rows.map((r) => r.title);

describe('database doc', () => {
  it('starts like a new Notion database: Name, Tags and a table view', () => {
    const doc = new Y.Doc();
    expect(isDatabaseDoc(doc)).toBe(false);
    initDatabase(doc, { databaseId: 'db' });
    expect(isDatabaseDoc(doc)).toBe(true);
    const db = readDatabase(doc);
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([
      ['Name', 'title'],
      ['Tags', 'multiSelect'],
    ]);
    expect(db.views).toMatchObject([{ name: 'Table', type: 'table', viewSet: 'db' }]);
    expect(db.rows).toEqual([]);
    initDatabase(doc, { databaseId: 'db' }); // idempotent
    expect(readDatabase(doc).properties).toHaveLength(2);
  });

  it('adds rows in order with metadata and sequence numbers', () => {
    const doc = setup();
    const a = addRow(doc, { actor: 'u1', title: 'A', now: 10 });
    addRow(doc, { actor: 'u1', title: 'C' });
    addRow(doc, { actor: 'u1', title: 'B', afterId: a });
    addRow(doc, { actor: 'u1', title: 'Z', beforeId: a });
    expect(titles(doc)).toEqual(['Z', 'A', 'B', 'C']);
    const row = readDatabase(doc).rows.find((r) => r.id === a)!;
    expect(row).toMatchObject({ createdAt: 10, createdBy: 'u1', uid: 1, trashedAt: null });
    expect(
      readDatabase(doc)
        .rows.map((r) => r.uid)
        .sort(),
    ).toEqual([1, 2, 3, 4]);
  });

  it('sets and clears cells, tracking the last editor', () => {
    const doc = setup();
    const row = addRow(doc, { actor: 'u1', now: 1 });
    const num = addProperty(doc, { name: 'Count', type: 'number' });
    setCell(doc, row, num, 3, 'u2', 5);
    setRowTitle(doc, row, 'Servo', 'u2', 6);
    let r = readDatabase(doc).rows[0]!;
    expect(r).toMatchObject({ title: 'Servo', updatedAt: 6, updatedBy: 'u2' });
    expect(r.values[num]).toBe(3);
    setCell(doc, row, num, null, 'u2');
    r = readDatabase(doc).rows[0]!;
    expect(num in r.values).toBe(false);
  });

  it('moves, duplicates and trashes rows', () => {
    const doc = setup();
    const a = addRow(doc, { actor: null, title: 'A' });
    const b = addRow(doc, { actor: null, title: 'B' });
    moveRow(doc, b, a);
    expect(titles(doc)).toEqual(['B', 'A']);
    moveRow(doc, b, null);
    expect(titles(doc)).toEqual(['A', 'B']);
    const copy = duplicateRow(doc, a, null);
    expect(titles(doc)).toEqual(['A', 'A', 'B']);
    trashRow(doc, copy, 100);
    expect(emptyRowTrashBefore(doc, 50)).toEqual([]);
    expect(emptyRowTrashBefore(doc, 200)).toEqual([copy]);
    expect(titles(doc)).toEqual(['A', 'B']);
  });

  it('adds, duplicates and deletes properties, keeping views in step', () => {
    const doc = setup();
    const row = addRow(doc, { actor: null });
    const tags = readDatabase(doc).properties[1]!.id;
    const done = addProperty(doc, { name: 'Done', type: 'checkbox' });
    const est = addProperty(doc, { name: 'Estimate', type: 'number', afterId: TITLE_PROPERTY_ID });
    expect(names(doc)).toEqual(['Name', 'Estimate', 'Tags', 'Done']);
    const view = readDatabase(doc).views[0]!;
    const props = readDatabase(doc).properties;
    expect(viewColumns(view, props).map((c) => c.id)).toEqual([TITLE_PROPERTY_ID, est, tags, done]);

    setCell(doc, row, est, 5, null);
    const copy = duplicateProperty(doc, est);
    expect(names(doc)).toEqual(['Name', 'Estimate', 'Estimate 1', 'Tags', 'Done']);
    expect(readDatabase(doc).rows[0]!.values[copy]).toBe(5);

    deleteProperty(doc, est);
    expect(names(doc)).not.toContain('Estimate');
    expect(est in readDatabase(doc).rows[0]!.values).toBe(false);
    expect(() => deleteProperty(doc, TITLE_PROPERTY_ID)).toThrow();
  });

  it('reorders, hides and resizes columns per view; the title stays first', () => {
    const doc = setup();
    const a = addProperty(doc, { name: 'A', type: 'text' });
    const view = readDatabase(doc).views[0]!;
    const tags = readDatabase(doc).properties[1]!.id;
    moveViewColumn(doc, view.id, a, tags);
    moveViewColumn(doc, view.id, a, TITLE_PROPERTY_ID);
    updateViewColumn(doc, view.id, tags, { visible: false, width: 300 });
    const db = readDatabase(doc);
    expect(viewColumns(db.views[0]!, db.properties)).toEqual([
      { id: TITLE_PROPERTY_ID, visible: true },
      { id: a, visible: true },
      { id: tags, visible: false, width: 300 },
    ]);
  });

  it('converts values through their text when a property changes type', () => {
    const doc = setup();
    const p = addProperty(doc, { name: 'P', type: 'text' });
    const rows = ['12', 'Done', '', 'Done'].map((text) => {
      const id = addRow(doc, { actor: null });
      setCell(doc, id, p, text, null);
      return id;
    });
    changePropertyType(doc, p, 'select', ctx);
    let db = readDatabase(doc);
    const prop = db.properties.find((x) => x.id === p)!;
    expect(prop.config.options!.map((o) => o.name)).toEqual(['12', 'Done']);
    const done = prop.config.options![1]!.id;
    expect(db.rows.map((r) => r.values[p] ?? null)).toEqual([
      prop.config.options![0]!.id,
      done,
      null,
      done,
    ]);

    changePropertyType(doc, p, 'status', ctx);
    db = readDatabase(doc);
    expect(db.properties.find((x) => x.id === p)!.config.options!.every((o) => o.group)).toBe(true);

    changePropertyType(doc, p, 'number', ctx);
    db = readDatabase(doc);
    expect(db.rows.map((r) => r.values[p] ?? null)).toEqual([12, null, null, null]);
    expect(rows).toHaveLength(4);
  });

  it('removes a deleted option from every row', () => {
    const doc = setup();
    const tags = readDatabase(doc).properties[1]!.id;
    addOption(doc, tags, { id: 'x', name: 'X', color: 'red' });
    addOption(doc, tags, { id: 'y', name: 'Y', color: 'blue' });
    const a = addRow(doc, { actor: null, values: { [tags]: ['x', 'y'] } });
    addRow(doc, { actor: null, values: { [tags]: ['x'] } });
    deleteOption(doc, tags, 'x');
    const db = readDatabase(doc);
    expect(db.rows.map((r) => r.values[tags] ?? null)).toEqual([['y'], null]);
    expect(db.rows[0]!.id).toBe(a);
  });

  it('copies a database with fresh row ids', () => {
    const doc = setup();
    const a = addRow(doc, { actor: null, title: 'A' });
    const copy = new Y.Doc();
    const mapping = copyDatabase(doc, copy, { fromViewSet: 'db', toViewSet: 'db2' });
    const db = readDatabase(copy);
    expect(db.rows.map((r) => r.title)).toEqual(['A']);
    expect(db.rows[0]!.id).toBe(mapping.get(a));
    expect(db.rows[0]!.id).not.toBe(a);
    expect(db.views.map((v) => v.viewSet)).toEqual(['db2']);
    setRowTitle(copy, db.rows[0]!.id, 'B', null);
    expect(titles(doc)).toEqual(['A']);
  });

  it('merges concurrent edits to different cells of a row', () => {
    const one = setup();
    const row = addRow(one, { actor: null });
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    const tags = readDatabase(one).properties[1]!.id;
    const num = addProperty(one, { name: 'N', type: 'number' });
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    setCell(one, row, num, 1, null);
    setCell(two, row, tags, ['t'], null);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    expect(readDatabase(one).rows[0]!.values).toEqual({ [num]: 1, [tags]: ['t'] });
    expect(readDatabase(two).rows[0]!.values).toEqual({ [num]: 1, [tags]: ['t'] });
  });
});
