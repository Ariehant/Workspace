import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  addProperty,
  addView,
  addWidget,
  defaultWidgets,
  deleteProperty,
  ensureViewSet,
  initDatabase,
  moveWidget,
  newWidget,
  numberWidgetText,
  readDatabase,
  removeWidget,
  setViewType,
  updateView,
  updateWidget,
  widgetTitle,
  type DashboardConfig,
} from './index';
import { prop, row } from './testing';

const ctx = { users: new Map<string, string>(), now: new Date(2026, 10, 20, 12).getTime() };

describe('dashboards', () => {
  it('start with a page count, and a chart by a select-like property when there is one', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const tags = readDatabase(doc).properties.find((p) => p.type === 'multiSelect')!;
    const id = addView(doc, { viewSet: 'db', name: 'Overview', type: 'dashboard' });
    const view = readDatabase(doc).views.find((v) => v.id === id)!;
    expect(view.dashboard.widgets.map((w) => w.kind)).toEqual(['number', 'chart']);
    expect(view.dashboard.widgets[1]!.chart!.x).toEqual({ propertyId: tags.id });

    // Only the title to chart by: no chart.
    deleteProperty(doc, tags.id);
    const plain = addView(doc, { viewSet: 'db', name: 'Plain', type: 'dashboard' });
    expect(
      readDatabase(doc)
        .views.find((v) => v.id === plain)!
        .dashboard.widgets.map((w) => w.kind),
    ).toEqual(['number']);

    // A view turned into a dashboard gets the starters once; its own widgets stay after.
    const first = readDatabase(doc).views[0]!.id;
    setViewType(doc, first, 'dashboard');
    const widgets = readDatabase(doc).views[0]!.dashboard.widgets;
    expect(widgets).toHaveLength(1);
    setViewType(doc, first, 'table');
    setViewType(doc, first, 'dashboard');
    expect(readDatabase(doc).views[0]!.dashboard.widgets).toEqual(widgets);
    expect(defaultWidgets(null)).toHaveLength(1);
  });

  it('numbers: the row count, or a calculation in the property format', () => {
    const points = prop('points', 'number', { numberFormat: 'commas' });
    const done = prop('done', 'checkbox');
    const rows = [
      row('1', { points: 1500, done: true }),
      row('2', { points: 3, done: false }),
      row('3', { points: 15 }),
    ];
    const number = (propertyId: string | null, calc: 'countAll' | 'sum' | 'percentChecked') =>
      numberWidgetText(
        rows,
        [points, done],
        { ...newWidget('number'), number: { propertyId, calc } },
        ctx,
      );
    expect(number(null, 'countAll')).toBe('3');
    expect(number('points', 'sum')).toBe('1,518');
    expect(number('done', 'percentChecked')).toBe('33.3%');
    // A property since deleted: the count.
    expect(number('gone', 'sum')).toBe('3');
  });

  it('widgets are added, changed, moved and removed', () => {
    let config: DashboardConfig = { widgets: [] };
    const a = newWidget('number');
    const b = newWidget('chart', { x: { propertyId: 'status' } });
    const c = newWidget('view', { viewId: 'v2' });
    for (const w of [a, b, c]) config = addWidget(config, w);
    expect(config.widgets.map((w) => w.id)).toEqual([a.id, b.id, c.id]);
    expect([a.width, b.width, c.width]).toEqual([1, 2, 3]);
    config = moveWidget(config, c.id, -1);
    expect(config.widgets.map((w) => w.id)).toEqual([a.id, c.id, b.id]);
    // At an end, it stays.
    expect(moveWidget(config, a.id, -1)).toBe(config);
    config = updateWidget(config, b.id, { title: 'By status', width: 3 });
    expect(config.widgets.find((w) => w.id === b.id)).toMatchObject({
      title: 'By status',
      width: 3,
    });
    config = removeWidget(config, a.id);
    expect(config.widgets.map((w) => w.id)).toEqual([c.id, b.id]);
  });

  it('titles when a widget has none of its own', () => {
    const points = prop('points', 'number');
    const names = (id: string) => (id === 'v2' ? 'Board' : undefined);
    expect(widgetTitle(newWidget('number'), [points], names)).toBe('Pages');
    expect(
      widgetTitle(
        { ...newWidget('number'), number: { propertyId: 'points', calc: 'sum' } },
        [points],
        names,
      ),
    ).toBe('Sum · points');
    expect(widgetTitle(newWidget('chart', { x: { propertyId: 'points' } }), [points], names)).toBe(
      'By points',
    );
    expect(widgetTitle(newWidget('view', { viewId: 'v2' }), [points], names)).toBe('Board');
    expect(widgetTitle({ ...newWidget('view'), title: 'Mine' }, [points], names)).toBe('Mine');
  });

  it('are kept in the doc (missing fields filled in) and copied to linked views', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const points = addProperty(doc, { name: 'Points', type: 'number' });
    const id = addView(doc, { viewSet: 'db', name: 'Overview', type: 'dashboard' });
    const widget = { ...newWidget('number'), number: { propertyId: points, calc: 'sum' as const } };
    updateView(doc, id, { dashboard: { widgets: [widget] } });
    // Written by an older or other client: a chart without all its settings, no width.
    const raw = doc.getMap<Y.Map<unknown>>('views').get(id)!;
    raw.set('dashboard', {
      widgets: [widget, { id: 'c', kind: 'chart', chart: { type: 'pie' } }, { kind: 'number' }],
    });
    const read = readDatabase(doc).views.find((v) => v.id === id)!.dashboard.widgets;
    expect(read).toHaveLength(2);
    expect(read[1]).toMatchObject({ id: 'c', kind: 'chart', title: '', width: 1 });
    expect(read[1]!.chart).toMatchObject({ type: 'pie', y: { kind: 'count' }, legend: true });

    // A linked view of a database whose first view is the dashboard copies it.
    const first = readDatabase(doc).views.filter((v) => v.viewSet === 'db')[0]!.id;
    updateView(doc, first, { dashboard: { widgets: [widget] } });
    setViewType(doc, first, 'dashboard');
    const linked = ensureViewSet(doc, 'block-1', 'db');
    const copy = readDatabase(doc).views.find((v) => v.id === linked)!;
    expect(copy.type).toBe('dashboard');
    expect(copy.dashboard.widgets).toEqual([widget]);
  });
});
