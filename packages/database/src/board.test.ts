import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addView,
  boardLayout,
  deleteProperty,
  groupMoveValue,
  groupRows,
  initDatabase,
  moveRowAfter,
  readDatabase,
  runView,
  setViewType,
  updateView,
  type SelectOption,
} from './index';

const ctx = { users: new Map<string, string>() };

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  return doc;
}
/** A database with just the title (no Tags). */
function bare() {
  const doc = setup();
  for (const p of readDatabase(doc).properties)
    if (p.type === 'multiSelect') deleteProperty(doc, p.id);
  return doc;
}
const view = (doc: Y.Doc, id: string) => readDatabase(doc).views.find((v) => v.id === id)!;

describe('board, list and gallery views', () => {
  it('a new board groups by the first status/select property, or adds a Status', () => {
    const doc = bare();
    const board = addView(doc, { viewSet: 'db', name: 'Board', type: 'board' });
    const status = readDatabase(doc).properties.find((p) => p.type === 'status')!;
    expect(status.name).toBe('Status');
    expect(view(doc, board).groupBy).toEqual({ propertyId: status.id });
    // Only the title shows on cards at first, and new properties stay off cards.
    expect(
      view(doc, board)
        .properties.filter((c) => c.visible)
        .map((c) => c.id),
    ).toEqual([TITLE_PROPERTY_ID]);
    const n = addProperty(doc, { name: 'N', type: 'number' });
    expect(view(doc, board).properties.find((c) => c.id === n)?.visible).toBe(false);
    expect(readDatabase(doc).views[0]!.properties.find((c) => c.id === n)?.visible).toBe(true);

    const select = setup();
    const tags = readDatabase(select).properties.find((p) => p.type === 'multiSelect')!;
    const b2 = addView(select, { viewSet: 'db', name: 'Board', type: 'board' });
    expect(view(select, b2).groupBy).toEqual({ propertyId: tags.id });
  });

  it('switching a view to board or gallery fills in what it needs', () => {
    const doc = setup();
    const id = readDatabase(doc).views[0]!.id;
    setViewType(doc, id, 'gallery');
    expect(view(doc, id)).toMatchObject({ type: 'gallery', cardPreview: { kind: 'content' } });
    setViewType(doc, id, 'board');
    expect(view(doc, id).groupBy).not.toBeNull();
    expect(view(doc, id)).toMatchObject({
      cardSize: 'medium',
      fitImage: false,
      colorColumns: true,
    });
  });

  it('moving a card between groups', () => {
    const doc = setup();
    const tags = readDatabase(doc).properties.find((p) => p.type === 'multiSelect')!;
    const options: SelectOption[] = [
      { id: 'a', name: 'A', color: 'red' },
      { id: 'b', name: 'B', color: 'blue' },
      { id: 'c', name: 'C', color: 'green' },
    ];
    const prop = { ...tags, config: { options } };
    const id = addRow(doc, { actor: null, values: { [tags.id]: ['a', 'c'] } });
    const row = readDatabase(doc).rows.find((r) => r.id === id)!;
    const groups = groupRows([row], prop, { propertyId: tags.id }, ctx);
    const info = (key: string) => groups.find((g) => g.info.key === key)!.info;
    expect(groupMoveValue(row, prop, info('a'), info('b'))).toEqual(['c', 'b']);
    expect(groupMoveValue(row, prop, info('a'), info('__none__'))).toEqual(['c']);
    const select = { ...prop, type: 'select' as const };
    expect(groupMoveValue(row, select, null, info('b'))).toEqual(['b']);
    expect(groupMoveValue(row, prop, null, { key: 'x', label: 'x', value: undefined })).toBe(
      undefined,
    );
  });

  it('moveRowAfter places a row right after another', () => {
    const doc = setup();
    for (const t of ['A', 'B', 'C']) addRow(doc, { actor: null, id: t, title: t });
    moveRowAfter(doc, 'A', 'C');
    expect(readDatabase(doc).rows.map((r) => r.id)).toEqual(['B', 'C', 'A']);
    moveRowAfter(doc, 'A', null);
    expect(readDatabase(doc).rows.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    moveRowAfter(doc, 'A', 'B');
    expect(readDatabase(doc).rows.map((r) => r.id)).toEqual(['B', 'A', 'C']);
  });

  it('board layout: columns from groups, swimlanes from sub-groups', () => {
    const doc = bare();
    const board = addView(doc, { viewSet: 'db', name: 'Board', type: 'board' });
    const status = readDatabase(doc).properties.find((p) => p.type === 'status')!;
    const [todo, doing] = status.config.options!;
    const done = addProperty(doc, { name: 'Done', type: 'checkbox' });
    addRow(doc, { actor: null, id: 'r1', values: { [status.id]: todo!.id } });
    addRow(doc, { actor: null, id: 'r2', values: { [status.id]: doing!.id, [done]: true } });
    addRow(doc, { actor: null, id: 'r3', values: { [status.id]: todo!.id, [done]: true } });
    const layout = () => {
      const snapshot = readDatabase(doc);
      const v = view(doc, board);
      return boardLayout(runView(snapshot, v, ctx), snapshot, v, ctx);
    };
    let l = layout();
    expect(l.columns.map((c) => c.info.label)).toEqual([
      'No Status',
      'Not started',
      'In progress',
      'Done',
    ]);
    expect(l.lanes).toHaveLength(1);
    expect(l.lanes[0]!.cells.get(todo!.id)!.map((r) => r.id)).toEqual(['r1', 'r3']);

    updateView(doc, board, { subGroupBy: { propertyId: done, hidden: ['false'] } });
    l = layout();
    expect(l.lanes.map((x) => [x.info!.label, x.hidden, x.count])).toEqual([
      ['Checked', false, 2],
      ['Unchecked', true, 1],
    ]);
    expect(l.lanes[0]!.cells.get(todo!.id)!.map((r) => r.id)).toEqual(['r3']);
    expect(l.lanes[0]!.cells.get(doing!.id)!.map((r) => r.id)).toEqual(['r2']);
  });
});
