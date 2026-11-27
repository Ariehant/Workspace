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
  readRowDates,
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
    // In someone else's time zone (the server).
    expect(dateReminderTime({ start: '2026-10-20', reminder: '1d' }, 'Asia/Tokyo')).toBe(
      Date.UTC(2026, 9, 19, 0),
    );
    expect(dateReminderTime({ start: '2026-10-20T15:00', reminder: '15m' }, 'Europe/London')).toBe(
      Date.UTC(2026, 9, 20, 13, 45),
    );
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

describe('readRowDates', () => {
  it('reads every date property of live rows, with ends for days and times', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const when = addProperty(doc, { name: 'When', type: 'date' });
    const due = addProperty(doc, { name: 'Due', type: 'date' });
    const a = addRow(doc, {
      actor: null,
      title: 'Standup',
      values: { [when]: { start: '2026-12-01T09:30' }, [due]: { start: '2026-12-02' } },
    });
    const b = addRow(doc, {
      actor: null,
      title: 'Trip',
      values: { [when]: { start: '2026-12-03', end: '2026-12-05' } },
    });
    const gone = addRow(doc, {
      actor: null,
      title: 'Gone',
      values: { [when]: { start: '2026-12-01' } },
    });
    trashRow(doc, gone);
    addRow(doc, { actor: null, title: 'No date', values: {} });

    const dates = readRowDates(readDatabase(doc));
    expect(dates).toEqual(
      expect.arrayContaining([
        {
          rowId: a,
          propertyId: when,
          start: '2026-12-01T09:30',
          end: '2026-12-01T09:30',
          allDay: false,
        },
        { rowId: a, propertyId: due, start: '2026-12-02', end: '2026-12-02T23:59', allDay: true },
        { rowId: b, propertyId: when, start: '2026-12-03', end: '2026-12-05T23:59', allDay: true },
      ]),
    );
    expect(dates).toHaveLength(3);
  });
});
