import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addRowFromTemplate,
  addTemplate,
  addView,
  applyTemplate,
  copyDatabase,
  defaultTemplate,
  deleteTemplate,
  duplicateTemplate,
  ensureViewSet,
  fillFromTable,
  initDatabase,
  readDatabase,
  readDateReminders,
  runView,
  setCell,
  setMeta,
  setRowPageFields,
  setRowTitle,
  tableCells,
  templatesOf,
  updateView,
  viewsOf,
} from './index';

const ctx = { users: new Map<string, string>() };

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  return doc;
}
const snap = (doc: Y.Doc) => readDatabase(doc);

describe('templates', () => {
  it('are hidden from views and reminders, and listed as templates', () => {
    const doc = setup();
    const due = addProperty(doc, { name: 'Due', type: 'date' });
    addRow(doc, { actor: null, id: 'r', title: 'Row' });
    const t = addTemplate(doc, { actor: null, title: 'Bug report' });
    setCell(doc, t, due, { start: '2099-01-01', reminder: 'onDay' }, null);
    const view = snap(doc).views[0]!;
    expect(runView(snap(doc), view, ctx).rows.map((r) => r.id)).toEqual(['r']);
    expect(templatesOf(snap(doc)).map((r) => r.title)).toEqual(['Bug report']);
    expect(readDateReminders(snap(doc))).toEqual([]);
  });

  it('new rows copy the template; group values win', () => {
    const doc = setup();
    const n = addProperty(doc, { name: 'N', type: 'number' });
    const s = addProperty(doc, { name: 'S', type: 'text' });
    const t = addTemplate(doc, { actor: null, title: 'Weekly review' });
    setCell(doc, t, n, 3, null);
    setCell(doc, t, s, 'from template', null);
    setRowPageFields(doc, t, { icon: '📝' }, null);
    const id = addRowFromTemplate(doc, t, { actor: 'u1', values: { [s]: 'group' } });
    const row = snap(doc).rows.find((r) => r.id === id)!;
    expect(row).toMatchObject({
      title: 'Weekly review',
      icon: '📝',
      isTemplate: false,
      createdBy: 'u1',
    });
    expect(row.values).toEqual({ [n]: 3, [s]: 'group' });
    expect(addRowFromTemplate(doc, null, { actor: null })).toBeTruthy();
  });

  it('applying to an existing row fills what is empty', () => {
    const doc = setup();
    const n = addProperty(doc, { name: 'N', type: 'number' });
    const s = addProperty(doc, { name: 'S', type: 'text' });
    const t = addTemplate(doc, { actor: null, title: 'T' });
    setCell(doc, t, n, 3, null);
    setCell(doc, t, s, 'x', null);
    addRow(doc, { actor: null, id: 'r', values: { [s]: 'mine' } });
    applyTemplate(doc, 'r', t, null);
    const row = snap(doc).rows.find((r) => r.id === 'r')!;
    expect(row.title).toBe('T');
    expect(row.values).toEqual({ [n]: 3, [s]: 'mine' });
    setRowTitle(doc, 'r', 'Kept', null);
    applyTemplate(doc, 'r', t, null);
    expect(snap(doc).rows.find((r) => r.id === 'r')!.title).toBe('Kept');
  });

  it('defaults per database and per view; duplicate and delete', () => {
    const doc = setup();
    const a = addTemplate(doc, { actor: null, title: 'A' });
    const b = duplicateTemplate(doc, a, null);
    expect(templatesOf(snap(doc)).map((t) => t.title)).toEqual(['A', 'A']);
    const view = () => snap(doc).views[0]!;
    expect(defaultTemplate(snap(doc), view())).toBeNull();
    setMeta(doc, { defaultTemplateId: a });
    expect(defaultTemplate(snap(doc), view())?.id).toBe(a);
    updateView(doc, view().id, { defaultTemplateId: b });
    expect(defaultTemplate(snap(doc), view())?.id).toBe(b);
    updateView(doc, view().id, { defaultTemplateId: 'none' });
    expect(defaultTemplate(snap(doc), view())).toBeNull();
    updateView(doc, view().id, { defaultTemplateId: a });
    deleteTemplate(doc, a);
    expect(snap(doc).meta.defaultTemplateId).toBeNull();
    expect(view().defaultTemplateId).toBeNull();
    expect(templatesOf(snap(doc)).map((t) => t.id)).toEqual([b]);
  });

  it('copied databases keep their templates', () => {
    const doc = setup();
    addTemplate(doc, { actor: null, title: 'T' });
    const to = new Y.Doc();
    copyDatabase(doc, to, { fromViewSet: 'db', toViewSet: 'copy' });
    expect(templatesOf(snap(to)).map((t) => t.title)).toEqual(['T']);
  });
});

describe('linked views', () => {
  it('a view set gets its own first view, copied from the source', () => {
    const doc = setup();
    const source = snap(doc).views[0]!;
    updateView(doc, source.id, { wrap: true });
    const id = ensureViewSet(doc, 'block1', 'db');
    expect(ensureViewSet(doc, 'block1', 'db')).toBe(id);
    const linked = viewsOf(snap(doc), 'block1');
    expect(linked.map((v) => [v.name, v.type])).toEqual([['Table', 'table']]);
    // Changing the linked view leaves the source alone.
    updateView(doc, id, { sorts: [{ propertyId: TITLE_PROPERTY_ID, direction: 'desc' }] });
    expect(viewsOf(snap(doc), 'db')[0]!.sorts).toEqual([]);
    addView(doc, { viewSet: 'block1', name: 'Board', type: 'board' });
    expect(viewsOf(snap(doc), 'db')).toHaveLength(1);
    expect(viewsOf(snap(doc), 'block1')).toHaveLength(2);
  });
});

describe('simple tables and databases', () => {
  it('fills a database from table cells and back', () => {
    const doc = setup();
    fillFromTable(
      doc,
      [
        ['Part', 'Qty', 'Notes'],
        ['Servo', '4', 'metal gear'],
        ['Gearbox', '', ''],
      ],
      { header: true, actor: null },
    );
    const db = snap(doc);
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([
      ['Part', 'title'],
      ['Qty', 'text'],
      ['Notes', 'text'],
    ]);
    expect(db.rows.map((r) => r.title)).toEqual(['Servo', 'Gearbox']);
    expect(tableCells(doc, db.views[0]!.id, ctx)).toEqual([
      ['Part', 'Qty', 'Notes'],
      ['Servo', '4', 'metal gear'],
      ['Gearbox', '', ''],
    ]);
  });

  it('without a header row, columns get default names', () => {
    const doc = setup();
    fillFromTable(doc, [['a', 'b'], ['c']], { header: false, actor: null });
    expect(snap(doc).properties.map((p) => p.name)).toEqual(['Name', 'Column 2']);
    expect(snap(doc).rows.map((r) => r.title)).toEqual(['a', 'c']);
  });
});
