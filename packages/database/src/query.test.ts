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
