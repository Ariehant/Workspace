import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  DatabaseHandle,
  addProperty,
  addRow,
  initDatabase,
  moveRow,
  setCell,
  setRowTitle,
  updateView,
} from './index';

describe('DatabaseHandle', () => {
  it('rebuilds only what changed and notifies subscribers', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const a = addRow(doc, { actor: null, title: 'A' });
    const b = addRow(doc, { actor: null, title: 'B' });
    const handle = new DatabaseHandle('db', doc);
    const listener = vi.fn();
    handle.subscribe(listener);

    const first = handle.snapshot();
    expect(handle.snapshot()).toBe(first);
    setRowTitle(doc, a, 'A2', null);
    const second = handle.snapshot();
    expect(listener).toHaveBeenCalled();
    expect(second.rows.map((r) => r.title)).toEqual(['A2', 'B']);
    expect(second.rows[1]).toBe(first.rows[1]); // untouched row reused
    expect(second.properties).toBe(first.properties);

    moveRow(doc, b, a);
    expect(handle.snapshot().rows.map((r) => r.title)).toEqual(['B', 'A2']);
    const n = addProperty(doc, { name: 'N', type: 'number' });
    setCell(doc, b, n, 4, null);
    expect(handle.row(b)?.values[n]).toBe(4);
    expect(handle.snapshot().properties.map((p) => p.name)).toContain('N');
    handle.destroy();
  });

  it('keeps the properties when only a view changes (computed values stay cached)', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const estimate = addProperty(doc, { name: 'Estimate', type: 'number' });
    const handle = new DatabaseHandle('db', doc);
    const first = handle.snapshot();
    updateView(doc, first.views[0]!.id, { sorts: [{ propertyId: estimate, direction: 'asc' }] });
    const second = handle.snapshot();
    expect(second.views[0]!.sorts).toHaveLength(1);
    expect(second.properties).toBe(first.properties);
    expect(second.meta).toBe(first.meta);
    addProperty(doc, { name: 'Notes', type: 'text' });
    expect(handle.snapshot().properties).not.toBe(first.properties);
  });

  it('undoes local edits', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const handle = new DatabaseHandle('db', doc);
    const row = addRow(doc, { actor: null, title: 'A' });
    handle.undo.stopCapturing();
    setRowTitle(doc, row, 'Changed', null);
    handle.undo.undo();
    expect(handle.row(row)?.title).toBe('A');
    handle.undo.undo();
    expect(handle.row(row)).toBeUndefined();
  });
});
