import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  DEFAULT_VIEW_CONFIG,
  addView,
  calendarWeeks,
  chartData,
  dateOfDay,
  dayIndex,
  deleteProperty,
  dragSpan,
  initDatabase,
  isoOfDay,
  layoutWeek,
  readDatabase,
  rowDays,
  rowSpan,
  setViewType,
  shiftDateValue,
  timelineProperties,
  timelineTicks,
  withEndDay,
  withStartDay,
  type ChartConfig,
} from './index';
import { prop, row } from './testing';

const ctx = { users: new Map<string, string>() };
const day = (iso: string) => dayIndex(new Date(`${iso}T00:00`));
const date = prop('d', 'date');

describe('calendar', () => {
  it('day indices round-trip across DST changes', () => {
    for (const iso of ['2026-03-08', '2026-03-29', '2026-10-25', '2026-11-01', '2026-12-31']) {
      expect(isoOfDay(day(iso))).toBe(iso);
      expect(dateOfDay(day(iso)).getHours()).toBe(0);
    }
    expect(day('2026-10-05') - day('2026-10-04')).toBe(1);
  });

  it('month and week grids start on the chosen weekday', () => {
    const anchor = new Date(2026, 9, 15); // October 2026 starts on a Thursday
    const sunday = calendarWeeks(anchor, 'month', 0);
    expect(isoOfDay(sunday[0]![0]!)).toBe('2026-09-27');
    expect(isoOfDay(sunday.at(-1)![6]!)).toBe('2026-10-31');
    expect(sunday).toHaveLength(5);
    const monday = calendarWeeks(anchor, 'month', 1);
    expect(isoOfDay(monday[0]![0]!)).toBe('2026-09-28');
    expect(isoOfDay(monday.at(-1)![6]!)).toBe('2026-11-01');
    const week = calendarWeeks(anchor, 'week', 1);
    expect(week.map((w) => w.map(isoOfDay))).toEqual([
      [
        '2026-10-12',
        '2026-10-13',
        '2026-10-14',
        '2026-10-15',
        '2026-10-16',
        '2026-10-17',
        '2026-10-18',
      ],
    ]);
  });

  it('rows cover their date range; created time is one day', () => {
    expect(rowDays(row('a', { d: { start: '2026-10-05', end: '2026-10-07' } }), date)).toEqual({
      start: day('2026-10-05'),
      end: day('2026-10-07'),
    });
    expect(rowDays(row('b', {}), date)).toBeNull();
    const created = prop('c', 'createdTime');
    const r = row('c', {}, { createdAt: new Date(2026, 9, 5, 15).getTime() });
    expect(rowDays(r, created)).toEqual({ start: day('2026-10-05'), end: day('2026-10-05') });
  });

  it('lays out multi-day bars in lanes', () => {
    const first = day('2026-10-04'); // a Sunday
    const items = [
      { row: row('long', {}), start: first - 2, end: first + 3 },
      { row: row('one', {}), start: first + 1, end: first + 1 },
      { row: row('two', {}), start: first + 4, end: first + 5 },
      { row: row('later', {}), start: first + 8, end: first + 9 },
    ];
    const { bars, lanes } = layoutWeek(items, first);
    expect(lanes).toBe(2);
    expect(bars.map((b) => [b.row.id, b.startCol, b.endCol, b.lane, b.continuesBefore])).toEqual([
      ['long', 0, 3, 0, true],
      ['one', 1, 1, 1, false],
      ['two', 4, 5, 0, false],
    ]);
  });

  it('moves and resizes date values by days, keeping times', () => {
    expect(shiftDateValue({ start: '2026-10-30T09:30', end: '2026-11-02T10:00' }, 3)).toEqual({
      start: '2026-11-02T09:30',
      end: '2026-11-05T10:00',
    });
    expect(withEndDay({ start: '2026-10-05' }, day('2026-10-08'))).toEqual({
      start: '2026-10-05',
      end: '2026-10-08',
    });
    expect(withEndDay({ start: '2026-10-05', end: '2026-10-08' }, day('2026-10-01'))).toEqual({
      start: '2026-10-05',
    });
    expect(withStartDay({ start: '2026-10-05', end: '2026-10-08' }, day('2026-10-07'))).toEqual({
      start: '2026-10-07',
      end: '2026-10-08',
    });
    expect(withStartDay({ start: '2026-10-05', end: '2026-10-08' }, day('2026-10-08'))).toEqual({
      start: '2026-10-08',
    });
  });

  it('new calendar and timeline views pick (or add) a date property', () => {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const cal = addView(doc, { viewSet: 'db', name: 'Calendar', type: 'calendar' });
    const added = readDatabase(doc).properties.find((p) => p.type === 'date')!;
    expect(added.name).toBe('Date');
    expect(readDatabase(doc).views.find((v) => v.id === cal)!.dateProperty).toBe(added.id);
    const first = readDatabase(doc).views[0]!.id;
    setViewType(doc, first, 'timeline');
    expect(readDatabase(doc).views[0]!.dateProperty).toBe(added.id);
    setViewType(doc, first, 'chart');
    const tags = readDatabase(doc).properties.find((p) => p.type === 'multiSelect')!;
    expect(readDatabase(doc).views[0]!.chart.x).toEqual({ propertyId: tags.id });
    deleteProperty(doc, tags.id);
    const chart = addView(doc, { viewSet: 'db', name: 'Chart', type: 'chart' });
    expect(readDatabase(doc).views.find((v) => v.id === chart)!.chart.x).toEqual({
      propertyId: added.id,
      dateBucket: 'month',
    });
  });
});

describe('timeline', () => {
  const end = prop('e', 'date');
  it('spans come from a range or from start and end properties', () => {
    const r = row('a', {
      d: { start: '2026-10-05', end: '2026-10-07' },
      e: { start: '2026-10-10' },
    });
    const ms = (iso: string) => new Date(iso).getTime();
    expect(rowSpan(r, date)).toEqual({
      start: ms('2026-10-05T00:00'),
      end: ms('2026-10-08T00:00'),
      time: false,
    });
    expect(rowSpan(r, date, end)!.end).toBe(ms('2026-10-11T00:00'));
    expect(rowSpan(row('t', { d: { start: '2026-10-05T09:00' } }), date)).toEqual({
      start: ms('2026-10-05T09:00'),
      end: ms('2026-10-05T10:00'),
      time: true,
    });
    expect(rowSpan(row('n', {}), date)).toBeNull();
    expect(timelineProperties({ dateProperty: null, endDateProperty: 'e' }, [date, end])).toEqual({
      start: date,
      end,
    });
  });

  it('dragging bars and edges', () => {
    const r = row('a', { d: { start: '2026-10-05', end: '2026-10-07' } });
    expect(Object.fromEntries(dragSpan(r, date, undefined, 'move', { days: 2 }))).toEqual({
      d: { start: '2026-10-07', end: '2026-10-09' },
    });
    expect(Object.fromEntries(dragSpan(r, date, undefined, 'end', { days: 3 }))).toEqual({
      d: { start: '2026-10-05', end: '2026-10-10' },
    });
    expect(Object.fromEntries(dragSpan(r, date, undefined, 'start', { days: -1 }))).toEqual({
      d: { start: '2026-10-04', end: '2026-10-07' },
    });
    const two = row('b', { d: { start: '2026-10-05' }, e: { start: '2026-10-09' } });
    expect(Object.fromEntries(dragSpan(two, date, end, 'move', { days: 1 }))).toEqual({
      d: { start: '2026-10-06' },
      e: { start: '2026-10-10' },
    });
    expect(Object.fromEntries(dragSpan(two, date, end, 'end', { days: 1 }))).toEqual({
      e: { start: '2026-10-10' },
    });
    const timed = row('t', { d: { start: '2026-10-05T09:00', end: '2026-10-05T10:00' } });
    expect(
      Object.fromEntries(dragSpan(timed, date, undefined, 'move', { days: 0, hours: 2 })),
    ).toEqual({
      d: { start: '2026-10-05T11:00', end: '2026-10-05T12:00' },
    });
  });

  it('header ticks follow the zoom', () => {
    const from = new Date(2026, 9, 1).getTime();
    const to = new Date(2026, 11, 31).getTime();
    expect(timelineTicks(from, to, 'week').major.map((t) => t.label)).toEqual([
      'Oct 2026',
      'Nov 2026',
      'Dec 2026',
    ]);
    expect(timelineTicks(from, to, 'quarter').minor.map((t) => t.label)).toEqual([
      'Oct',
      'Nov',
      'Dec',
    ]);
    expect(timelineTicks(from, from, 'hours').minor).toHaveLength(24);
  });
});

describe('chart data', () => {
  const stage = prop('s', 'select', {
    options: [
      { id: 'a', name: 'Doing', color: 'blue' },
      { id: 'b', name: 'Done', color: 'green' },
    ],
  });
  const cost = prop('n', 'number');
  const owner = prop('o', 'text');
  const rows = [
    row('1', { s: 'a', n: 10, o: 'x' }),
    row('2', { s: 'a', n: 30, o: 'y' }),
    row('3', { s: 'b', n: 5, o: 'x' }),
    row('4', { n: 7 }),
  ];
  const properties = [prop(TITLE_PROPERTY_ID, 'title'), stage, cost, owner];
  const config = (c: Partial<ChartConfig>): ChartConfig => ({
    ...DEFAULT_VIEW_CONFIG.chart,
    x: { propertyId: 's' },
    ...c,
  });

  it('counts rows per X group in the property order', () => {
    const data = chartData(rows, properties, config({}), ctx);
    expect(data.categories.map((c) => [c.label, c.total, c.color])).toEqual([
      ['No s', 1, undefined],
      ['Doing', 2, 'blue'],
      ['Done', 1, 'green'],
    ]);
    expect(data.series).toEqual([{ key: 'value', label: 'Count' }]);
  });

  it('sums a property, splits into series, sorts and hides empties', () => {
    const data = chartData(
      rows,
      properties,
      config({
        y: { kind: 'property', propertyId: 'n', calc: 'sum' },
        series: { propertyId: 'o' },
        sort: 'yDesc',
        hideEmpty: true,
      }),
      ctx,
    );
    expect(data.series.map((s) => s.label)).toEqual(['No o', 'x', 'y']);
    expect(data.categories.map((c) => [c.label, c.total, c.values])).toEqual([
      ['Doing', 40, { __none__: 0, x: 10, y: 30 }],
      ['No s', 7, { __none__: 7, x: 0, y: 0 }],
      ['Done', 5, { __none__: 0, x: 5, y: 0 }],
    ]);
    const avg = chartData(
      rows,
      properties,
      config({ y: { kind: 'property', propertyId: 'n', calc: 'average' } }),
      ctx,
    );
    expect(avg.categories.find((c) => c.label === 'Doing')!.total).toBe(20);
    // Pies have no series.
    const pie = chartData(
      rows,
      properties,
      config({ type: 'pie', series: { propertyId: 'o' } }),
      ctx,
    );
    expect(pie.series).toHaveLength(1);
  });
});
