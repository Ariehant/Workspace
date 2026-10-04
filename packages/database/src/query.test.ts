import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { addProperty, addRow, initDatabase, readDatabase, runView, updateView } from './index';

const ctx = { users: new Map<string, string>() };

describe('runView', () => {
  it('shows live rows in manual order, or sorted with empties last', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const n = addProperty(doc, { name: 'N', type: 'number' });
    const data: [string, number | null][] = [
      ['b', 2],
      ['empty', null],
      ['a', 10],
      ['c', 2],
    ];
    for (const [title, value] of data) addRow(doc, { actor: null, title, values: { [n]: value } });
    const view = () => readDatabase(doc).views[0]!;
    const titles = () => runView(readDatabase(doc), view(), ctx).rows.map((r) => r.title);
    expect(titles()).toEqual(['b', 'empty', 'a', 'c']);

    updateView(doc, view().id, { sorts: [{ propertyId: n, direction: 'desc' }] });
    expect(titles()).toEqual(['a', 'b', 'c', 'empty']);

    updateView(doc, view().id, {
      sorts: [
        { propertyId: n, direction: 'asc' },
        { propertyId: 'title', direction: 'desc' },
      ],
    });
    expect(titles()).toEqual(['c', 'b', 'a', 'empty']);
  });
});

describe('runView with filters, search and groups', () => {
  it('filters, searches and groups', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const n = addProperty(doc, { name: 'N', type: 'number' });
    const c = addProperty(doc, { name: 'Done', type: 'checkbox' });
    for (const [title, value, done] of [
      ['arm', 3, true],
      ['leg', 8, false],
      ['eye', 1, false],
    ] as const) {
      addRow(doc, { actor: null, title, values: { [n]: value, [c]: done } });
    }
    const view = readDatabase(doc).views[0]!;
    updateView(doc, view.id, {
      filter: {
        type: 'group',
        id: 'root',
        conjunction: 'and',
        filters: [{ type: 'rule', id: 'r', propertyId: n, operator: 'gt', value: 2 }],
      },
      groupBy: { propertyId: c },
    });
    const v = readDatabase(doc).views[0]!;
    const result = runView(readDatabase(doc), v, ctx);
    expect(result.rows.map((r) => r.title)).toEqual(['arm', 'leg']);
    expect(result.groups!.map((g) => `${g.info.label}:${g.rows.map((r) => r.title)}`)).toEqual([
      'Checked:arm',
      'Unchecked:leg',
    ]);
    expect(runView(readDatabase(doc), v, ctx, { search: 'LE' }).rows.map((r) => r.title)).toEqual([
      'leg',
    ]);
  });
});
