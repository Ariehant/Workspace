import { ME, TODAY } from '@workspace/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addRow,
  addRowFromTemplate,
  addTemplate,
  applyTemplate,
  createRelation,
  initDatabase,
  propertyKind,
  readDatabase,
  readRelation,
  resolvePlaceholders,
  runDatabaseStep,
  setCell,
  type DocResolver,
} from './index';
import { prop } from './testing';

const NOW = new Date(2026, 9, 6, 10).getTime();
const ctx = { users: new Map([['u1', 'Ravi']]) };

function setup() {
  const docs = new Map<string, Y.Doc>();
  const db = (id: string) => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: id });
    docs.set(id, doc);
    return doc;
  };
  const resolve: DocResolver = (id) => docs.get(id);
  return { db, resolve };
}

describe('placeholders', () => {
  const date = prop('d', 'date');
  const people = prop('p', 'person');
  it('fill @today and @me when used', () => {
    expect(
      resolvePlaceholders({ d: { start: TODAY }, p: [ME, 'u2', ME], x: 'kept' }, [date, people], {
        me: 'u1',
        now: NOW,
      }),
    ).toEqual({ d: { start: '2026-10-06' }, p: ['u1', 'u2'], x: 'kept' });
    expect(resolvePlaceholders({ p: [ME] }, [people], { me: null })).toEqual({ p: [] });
  });

  it('show as placeholders in templates', () => {
    expect(propertyKind('date').isEmpty({ start: TODAY })).toBe(false);
    expect(propertyKind('date').text({ start: TODAY }, date, ctx)).toBe('Today (when used)');
    expect(propertyKind('person').text([ME], people, ctx)).toBe('Me (when used)');
  });

  it('templates fill them in new and existing rows', () => {
    const { db } = setup();
    const doc = db('tasks');
    const due = addProperty(doc, { name: 'Due', type: 'date' });
    const owner = addProperty(doc, { name: 'Owner', type: 'person' });
    const t = addTemplate(doc, { actor: null, title: 'Daily' });
    setCell(doc, t, due, { start: TODAY }, null);
    setCell(doc, t, owner, [ME], null);
    const id = addRowFromTemplate(doc, t, { actor: 'u1', context: { me: 'u1', now: NOW } });
    expect(readDatabase(doc).rows.find((r) => r.id === id)!.values).toEqual({
      [due]: { start: '2026-10-06' },
      [owner]: ['u1'],
    });
    addRow(doc, { actor: null, id: 'r' });
    applyTemplate(doc, 'r', t, 'u2');
    expect(readDatabase(doc).rows.find((r) => r.id === 'r')!.values[owner]).toEqual(['u2']);
  });
});

describe('button steps', () => {
  it('add a page with values (placeholders filled, relations two-way)', () => {
    const { db, resolve } = setup();
    const tasks = db('tasks');
    const projects = db('projects');
    addRow(projects, { actor: null, id: 'p1', title: 'Arm' });
    const due = addProperty(tasks, { name: 'Due', type: 'date' });
    const { propertyId: rel, syncedPropertyId: back } = createRelation(resolve, {
      databaseId: 'tasks',
      targetId: 'projects',
      name: 'Project',
      twoWay: { name: 'Tasks' },
    });
    const id = runDatabaseStep(
      {
        kind: 'addPage',
        databaseId: 'tasks',
        title: 'Standup',
        values: { [due]: { start: TODAY }, [rel]: ['p1'] },
        open: true,
      },
      { resolve, actor: 'u1', now: NOW, ctx },
    )!;
    const row = readDatabase(tasks).rows.find((r) => r.id === id)!;
    expect(row.title).toBe('Standup');
    expect(row.values[due]).toEqual({ start: '2026-10-06' });
    expect(readRelation(projects, 'p1', back!)).toEqual([id]);
  });

  it('edit matching pages, or the row the button is in; missing databases are skipped', () => {
    const { db, resolve } = setup();
    const doc = db('tasks');
    const done = addProperty(doc, { name: 'Done', type: 'checkbox' });
    const stage = addProperty(doc, { name: 'Stage', type: 'text' });
    for (const [id, s] of [
      ['a', 'review'],
      ['b', 'draft'],
      ['c', 'review'],
    ] as const) {
      addRow(doc, { actor: null, id, values: { [stage]: s } });
    }
    runDatabaseStep(
      {
        kind: 'editPages',
        databaseId: 'tasks',
        filter: { type: 'rule', id: 'f', propertyId: stage, operator: 'is', value: 'review' },
        values: { [done]: true },
      },
      { resolve, actor: 'u1', ctx },
    );
    const values = () => readDatabase(doc).rows.map((r) => r.values[done] ?? false);
    expect(values()).toEqual([true, false, true]);
    runDatabaseStep(
      { kind: 'editThisRow', values: { [done]: true } },
      { resolve, actor: 'u1', ctx, row: { databaseId: 'tasks', rowId: 'b' } },
    );
    expect(values()).toEqual([true, true, true]);
    expect(
      runDatabaseStep(
        { kind: 'addPage', databaseId: 'gone', title: '', values: {}, open: false },
        { resolve, actor: 'u1', ctx },
      ),
    ).toBeNull();
  });
});
