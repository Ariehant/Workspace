/**
 * Exit check for Phase 2: Notion's own templates rebuilt as databases. Every view is
 * rendered to plain data, the docs go through Yjs encoding (what storage keeps, so
 * this is a restart), and the views must render the same again.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ComputedCache,
  DatabaseHandle,
  TITLE_PROPERTY_ID,
  addProperty,
  addRow,
  addView,
  boardLayout,
  cellText,
  chartData,
  createRelation,
  initDatabase,
  readDatabase,
  rowDays,
  rowSpan,
  runView,
  setRelation,
  timelineProperties,
  updateView,
  viewColumns,
  viewsOf,
  type DatabaseSnapshot,
  type DocResolver,
  type SelectOption,
  type View,
} from './index';

const users = new Map([
  ['u1', 'Ravi'],
  ['u2', 'Mina'],
]);
const ctxBase = { users, me: 'u1', now: new Date(2026, 9, 5, 12).getTime() };

class Workspace {
  docs = new Map<string, Y.Doc>();
  resolve: DocResolver = (id) => this.docs.get(id);
  db(id: string) {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: id });
    this.docs.set(id, doc);
    return doc;
  }
  /** A fresh workspace from the encoded docs, as after a restart. */
  restart(): Workspace {
    const next = new Workspace();
    for (const [id, doc] of this.docs) {
      const copy = new Y.Doc();
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      next.docs.set(id, copy);
    }
    return next;
  }
  /** Computed snapshots (relations, rollups, formulas) of every database. */
  snapshots(): Map<string, DatabaseSnapshot> {
    const handles = new Map([...this.docs].map(([id, doc]) => [id, new DatabaseHandle(id, doc)]));
    const caches = new Map<string, ComputedCache>();
    const visiting = new Set<string>();
    const snap = (id: string, compute = true): DatabaseSnapshot => {
      const raw = handles.get(id)!.snapshot();
      if (!compute || visiting.has(id)) return raw;
      let cache = caches.get(id);
      if (!cache) caches.set(id, (cache = new ComputedCache()));
      visiting.add(id);
      try {
        return cache.apply(raw, ctxBase, snap, id);
      } finally {
        visiting.delete(id);
      }
    };
    return new Map([...this.docs.keys()].map((id) => [id, snap(id)]));
  }
}

const options = (...names: string[]): SelectOption[] =>
  names.map((name, i) => ({
    id: `o${i}-${name}`,
    name,
    color: (['blue', 'green', 'red', 'yellow'] as const)[i % 4]!,
  }));
const opt = (name: string, list: SelectOption[]) => list.find((o) => o.name === name)!.id;

/** Every view of a database rendered to plain data. */
function render(snapshot: DatabaseSnapshot, viewSet: string) {
  const ctx = { ...ctxBase, pages: snapshot.related };
  const byId = new Map(snapshot.properties.map((p) => [p.id, p]));
  return viewsOf(snapshot, viewSet).map((view: View) => {
    const result = runView(snapshot, view, ctx);
    const columns = viewColumns(view, snapshot.properties)
      .filter((c) => c.visible || view.type !== 'table')
      .map((c) => byId.get(c.id)!);
    const rows = result.rows.map((r) => columns.map((p) => cellText(r, p, ctx)));
    switch (view.type) {
      case 'board': {
        const layout = boardLayout(result, snapshot, view, ctx);
        return {
          view: view.name,
          columns: layout.columns.map((c) => [
            c.info.label,
            (layout.lanes[0]!.cells.get(c.info.key) ?? []).map((r) => r.title),
          ]),
        };
      }
      case 'calendar': {
        const date = byId.get(view.dateProperty!)!;
        return { view: view.name, days: result.rows.map((r) => [r.title, rowDays(r, date)]) };
      }
      case 'timeline': {
        const { start, end } = timelineProperties(view, snapshot.properties);
        return {
          view: view.name,
          spans: result.rows.map((r) => [r.title, rowSpan(r, start!, end)]),
        };
      }
      case 'chart':
        return {
          view: view.name,
          chart: chartData(result.rows, snapshot.properties, view.chart, ctx).categories.map(
            (c) => [c.label, c.total],
          ),
        };
      default:
        return { view: view.name, rows };
    }
  });
}

function renderAll(ws: Workspace) {
  const snapshots = ws.snapshots();
  return Object.fromEntries([...snapshots].map(([id, s]) => [id, render(s, id)]));
}

describe('exit check: Notion templates', () => {
  it('Tasks + Projects: relations, rollups, status, board, timeline', () => {
    const ws = new Workspace();
    const projects = ws.db('projects');
    const tasks = ws.db('tasks');
    const status = options('Not started', 'In progress', 'Done');
    const pStatus = addProperty(projects, {
      name: 'Status',
      type: 'status',
      config: {
        options: status.map((o, i) => ({
          ...o,
          group: (['todo', 'inProgress', 'complete'] as const)[i],
        })),
      },
    });
    const dates = addProperty(projects, { name: 'Dates', type: 'date' });
    const tStatus = addProperty(tasks, {
      name: 'Status',
      type: 'status',
      config: {
        options: status.map((o, i) => ({
          ...o,
          group: (['todo', 'inProgress', 'complete'] as const)[i],
        })),
      },
    });
    const done = addProperty(tasks, { name: 'Done', type: 'checkbox' });
    const due = addProperty(tasks, { name: 'Due', type: 'date' });
    const assignee = addProperty(tasks, { name: 'Assignee', type: 'person' });
    const { propertyId: rel, syncedPropertyId: back } = createRelation(ws.resolve, {
      databaseId: 'projects',
      targetId: 'tasks',
      name: 'Tasks',
      twoWay: { name: 'Project' },
    });
    const progress = addProperty(projects, {
      name: 'Progress',
      type: 'rollup',
      config: { relationId: rel, targetPropertyId: done, calculation: 'percentChecked' },
    });
    addRow(projects, {
      actor: 'u1',
      id: 'arm',
      title: 'Robot arm',
      values: {
        [pStatus]: opt('In progress', status),
        [dates]: { start: '2026-10-01', end: '2026-10-20' },
      },
    });
    addRow(projects, {
      actor: 'u1',
      id: 'base',
      title: 'Mobile base',
      values: {
        [pStatus]: opt('Not started', status),
        [dates]: { start: '2026-10-15', end: '2026-11-10' },
      },
    });
    const taskData: [string, string, boolean, string, string][] = [
      ['t1', 'Design gripper', true, 'Done', '2026-10-03'],
      ['t2', 'Tune PID', false, 'In progress', '2026-10-09'],
      ['t3', 'Order motors', false, 'Not started', '2026-10-18'],
    ];
    for (const [id, title, isDone, s, d] of taskData) {
      addRow(tasks, {
        actor: 'u1',
        id,
        title,
        values: {
          [done]: isDone,
          [tStatus]: opt(s, status),
          [due]: { start: d },
          [assignee]: ['u2'],
        },
      });
    }
    setRelation(ws.resolve, 'projects', 'arm', rel, ['t1', 't2'], 'u1');
    setRelation(ws.resolve, 'projects', 'base', rel, ['t3'], 'u1');
    addView(tasks, {
      viewSet: 'tasks',
      name: 'Board',
      type: 'board',
      config: { groupBy: { propertyId: tStatus } },
    });
    addView(projects, {
      viewSet: 'projects',
      name: 'Timeline',
      type: 'timeline',
      config: { dateProperty: dates },
    });

    const before = renderAll(ws);
    const snaps = ws.snapshots();
    const arm = snaps.get('projects')!.rows.find((r) => r.id === 'arm')!;
    expect(arm.values[progress]).toBe(50);
    expect(snaps.get('tasks')!.rows.find((r) => r.id === 't3')!.values[back!]).toEqual(['base']);
    expect(before.tasks![1]).toEqual({
      view: 'Board',
      columns: [
        ['No Status', []],
        ['Not started', ['Order motors']],
        ['In progress', ['Tune PID']],
        ['Done', ['Design gripper']],
      ],
    });
    expect(renderAll(ws.restart())).toEqual(before);
  });

  it('Reading list: gallery, select, rating formula', () => {
    const ws = new Workspace();
    const doc = ws.db('reading');
    const type = options('Book', 'Article', 'Paper');
    const kind = addProperty(doc, { name: 'Type', type: 'select', config: { options: type } });
    const rating = addProperty(doc, { name: 'Rating', type: 'number' });
    const stars = addProperty(doc, {
      name: 'Stars',
      type: 'formula',
      config: { expression: 'repeat("★", prop("Rating"))' },
    });
    const fav = addProperty(doc, {
      name: 'Favourite',
      type: 'formula',
      config: { expression: 'prop("Rating") >= 4' },
    });
    for (const [title, t, r] of [
      ['Probabilistic Robotics', 'Book', 5],
      ['Attention Is All You Need', 'Paper', 4],
      ['Gear design notes', 'Article', 2],
    ] as const) {
      addRow(doc, { actor: 'u1', title, values: { [kind]: opt(t, type), [rating]: r } });
    }
    const gallery = addView(doc, { viewSet: 'reading', name: 'Gallery', type: 'gallery' });
    updateView(doc, gallery, {
      properties: viewColumns(readDatabase(doc).views[1]!, readDatabase(doc).properties).map(
        (c) => ({ ...c, visible: true }),
      ),
      sorts: [{ propertyId: rating, direction: 'desc' }],
    });
    const before = renderAll(ws);
    const rows = ws.snapshots().get('reading')!.rows;
    expect(rows.map((r) => [r.values[stars], r.values[fav]])).toEqual([
      ['★★★★★', true],
      ['★★★★', true],
      ['★★', false],
    ]);
    expect((before.reading![1] as unknown as { rows: string[][] }).rows.map((r) => r[0])).toEqual([
      'Probabilistic Robotics',
      'Attention Is All You Need',
      'Gear design notes',
    ]);
    expect(renderAll(ws.restart())).toEqual(before);
  });

  it('Habit tracker: checkboxes, calculations, chart', () => {
    const ws = new Workspace();
    const doc = ws.db('habits');
    const date = addProperty(doc, { name: 'Date', type: 'date' });
    const habits = ['Exercise', 'Read', 'Meditate'].map((name) =>
      addProperty(doc, { name, type: 'checkbox' }),
    );
    const score = addProperty(doc, {
      name: 'Score',
      type: 'formula',
      config: {
        expression:
          'toNumber(prop("Exercise")) + toNumber(prop("Read")) + toNumber(prop("Meditate"))',
      },
    });
    const days: [string, boolean[]][] = [
      ['2026-10-01', [true, true, false]],
      ['2026-10-02', [true, false, false]],
      ['2026-10-05', [true, true, true]],
      ['2026-10-06', [false, true, true]],
    ];
    for (const [d, checks] of days) {
      addRow(doc, {
        actor: 'u1',
        title: d,
        values: {
          [date]: { start: d },
          ...Object.fromEntries(habits.map((h, i) => [h, checks[i]])),
        },
      });
    }
    const table = readDatabase(doc).views[0]!;
    updateView(doc, table.id, { calculations: { [habits[0]!]: 'percentChecked', [score]: 'sum' } });
    addView(doc, {
      viewSet: 'habits',
      name: 'Weekly',
      type: 'chart',
      config: {
        chart: {
          ...readDatabase(doc).views[0]!.chart,
          x: { propertyId: date, dateBucket: 'week' },
          y: { kind: 'property', propertyId: score, calc: 'sum' },
        },
      },
    });
    const before = renderAll(ws);
    expect(before.habits![1]).toMatchObject({ view: 'Weekly' });
    const totals = (before.habits![1] as unknown as { chart: [string, number][] }).chart.map(
      (c) => c[1],
    );
    expect(totals.reduce((a, b) => a + b, 0)).toBe(8);
    expect(totals).toHaveLength(2);
    expect(renderAll(ws.restart())).toEqual(before);
  });

  it('Simple CRM: relations, rollups, calendar', () => {
    const ws = new Workspace();
    const companies = ws.db('companies');
    const deals = ws.db('deals');
    const value = addProperty(deals, {
      name: 'Value',
      type: 'number',
      config: { numberFormat: 'euro' },
    });
    const close = addProperty(deals, { name: 'Close date', type: 'date' });
    const { propertyId: rel } = createRelation(ws.resolve, {
      databaseId: 'deals',
      targetId: 'companies',
      name: 'Company',
      limitOne: true,
      twoWay: { name: 'Deals' },
    });
    const back = readDatabase(companies).properties.find((p) => p.name === 'Deals')!.id;
    const total = addProperty(companies, {
      name: 'Pipeline',
      type: 'rollup',
      config: { relationId: back, targetPropertyId: value, calculation: 'sum' },
    });
    addRow(companies, { actor: 'u1', id: 'acme', title: 'Acme Robotics' });
    addRow(companies, { actor: 'u1', id: 'kin', title: 'Kinetic Labs' });
    for (const [id, title, v, d, company] of [
      ['d1', 'Arm retrofit', 12000, '2026-10-12', 'acme'],
      ['d2', 'Sensor kit', 3000, '2026-10-20', 'acme'],
      ['d3', 'AGV fleet', 45000, '2026-11-02', 'kin'],
    ] as const) {
      addRow(deals, { actor: 'u1', id, title, values: { [value]: v, [close]: { start: d } } });
      setRelation(ws.resolve, 'deals', id, rel, [company], 'u1');
    }
    addView(deals, {
      viewSet: 'deals',
      name: 'Calendar',
      type: 'calendar',
      config: { dateProperty: close },
    });
    const before = renderAll(ws);
    const snaps = ws.snapshots();
    expect(snaps.get('companies')!.rows.map((r) => r.values[total])).toEqual([15000, 45000]);
    const pipeline = snaps.get('companies')!.properties.find((p) => p.id === total)!;
    expect(cellText(snaps.get('companies')!.rows[0]!, pipeline, ctxBase)).toBe('€15,000.00');
    expect(renderAll(ws.restart())).toEqual(before);
  });

  it('Content calendar: calendar, person, status', () => {
    const ws = new Workspace();
    const doc = ws.db('content');
    const status = options('Idea', 'Drafting', 'Published');
    const st = addProperty(doc, {
      name: 'Status',
      type: 'status',
      config: {
        options: status.map((o, i) => ({
          ...o,
          group: (['todo', 'inProgress', 'complete'] as const)[i],
        })),
      },
    });
    const author = addProperty(doc, { name: 'Author', type: 'person' });
    const publish = addProperty(doc, { name: 'Publish date', type: 'date' });
    for (const [title, s, a, d] of [
      ['Servo teardown', 'Published', 'u1', '2026-10-02'],
      ['ROS 2 migration', 'Drafting', 'u2', '2026-10-16'],
      ['Gripper comparison', 'Idea', 'u1', null],
    ] as const) {
      addRow(doc, {
        actor: 'u1',
        title,
        values: { [st]: opt(s, status), [author]: [a], ...(d ? { [publish]: { start: d } } : {}) },
      });
    }
    addView(doc, {
      viewSet: 'content',
      name: 'Calendar',
      type: 'calendar',
      config: { dateProperty: publish },
    });
    addView(doc, {
      viewSet: 'content',
      name: 'By status',
      type: 'board',
      config: { groupBy: { propertyId: st } },
    });
    addView(doc, {
      viewSet: 'content',
      name: 'Mine',
      type: 'list',
      config: {
        filter: {
          type: 'group',
          id: 'g',
          conjunction: 'and',
          filters: [
            { type: 'rule', id: 'r', propertyId: author, operator: 'contains', value: ['me'] },
          ],
        },
      },
    });
    const before = renderAll(ws);
    expect((before.content![1] as unknown as { days: unknown[] }).days).toHaveLength(3);
    expect((before.content![3] as unknown as { rows: string[][] }).rows.map((r) => r[0])).toEqual([
      'Servo teardown',
      'Gripper comparison',
    ]);
    const authorCol = readDatabase(doc).properties.find((p) => p.id === author)!;
    expect(cellText(ws.snapshots().get('content')!.rows[1]!, authorCol, ctxBase)).toBe('Mina');
    expect(TITLE_PROPERTY_ID).toBe('title');
    expect(renderAll(ws.restart())).toEqual(before);
  });
});
