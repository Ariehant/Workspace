import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addRow,
  dateReminderTime,
  duplicateView,
  initDatabase,
  moveView,
  readDatabase,
  readDateReminders,
  setMeta,
  trashRow,
} from './index';

describe('date reminders', () => {
  it('fire at 9:00 for days, or before the time', () => {
    expect(dateReminderTime({ start: '2026-10-20', reminder: '1d' })).toBe(
      new Date(2026, 9, 19, 9).getTime(),
    );
    expect(dateReminderTime({ start: '2026-10-20T15:00', reminder: '15m' })).toBe(
      new Date(2026, 9, 20, 14, 45).getTime(),
    );
    expect(dateReminderTime({ start: '2026-10-20' })).toBeNull();
  });

  it('are read from live rows', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const due = addProperty(doc, { name: 'Due', type: 'date' });
    const a = addRow(doc, {
      actor: null,
      title: 'Ship',
      values: { [due]: { start: '2026-10-20', reminder: 'onDay' } },
    });
    const b = addRow(doc, {
      actor: null,
      values: { [due]: { start: '2026-10-21', reminder: 'onDay' } },
    });
    trashRow(doc, b);
    expect(readDateReminders(readDatabase(doc))).toEqual([
      { rowId: a, propertyId: due, fireAt: new Date(2026, 9, 20, 9).getTime(), text: 'Due: Ship' },
    ]);
  });
});

describe('views and meta', () => {
  it('duplicates and reorders views; meta is stored in the doc', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const first = readDatabase(doc).views[0]!;
    const copy = duplicateView(doc, first.id);
    expect(readDatabase(doc).views.map((v) => v.name)).toEqual(['Table', 'Table (1)']);
    moveView(doc, copy, first.id);
    expect(readDatabase(doc).views.map((v) => v.id)).toEqual([copy, first.id]);
    expect(readDatabase(doc).meta.hideEmptyProperties).toBe(false);
    setMeta(doc, { hideEmptyProperties: true });
    expect(readDatabase(doc).meta.hideEmptyProperties).toBe(true);
  });
});
