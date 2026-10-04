import { describe, expect, it } from 'vitest';
import { NO_VALUE, groupRows } from './index';
import { prop, row } from './testing';

const NOW = new Date(2026, 9, 4, 12).getTime();
const ctx = {
  users: new Map([
    ['u1', 'Ravi'],
    ['u2', 'Ana'],
  ]),
  now: NOW,
};
const names = (groups: ReturnType<typeof groupRows>) =>
  groups.map((g) => `${g.info.label}:${g.rows.map((r) => r.id).join(',')}`);

describe('grouping', () => {
  const select = prop(
    's',
    'select',
    {
      options: [
        { id: 'b', name: 'Backlog', color: 'gray' },
        { id: 'd', name: 'Doing', color: 'blue' },
      ],
    },
    'Stage',
  );

  it('groups by option in option order, with "No …" first and empty groups kept', () => {
    const rows = [row('1', { s: 'd' }), row('2', {}), row('3', { s: 'd' })];
    expect(names(groupRows(rows, select, { propertyId: 's' }, ctx))).toEqual([
      'No Stage:2',
      'Backlog:',
      'Doing:1,3',
    ]);
    expect(names(groupRows(rows, select, { propertyId: 's', hideEmpty: true }, ctx))).toEqual([
      'No Stage:2',
      'Doing:1,3',
    ]);
    const groups = groupRows(rows, select, { propertyId: 's', sort: 'desc' }, ctx);
    expect(groups.map((g) => g.info.key)).toEqual([NO_VALUE, 'd', 'b']);
    expect(groups[1]!.info.value).toBe('d');
  });

  it('puts multi-select rows in each of their groups', () => {
    const multi = prop('m', 'multiSelect', {
      options: [
        { id: 'x', name: 'X', color: 'red' },
        { id: 'y', name: 'Y', color: 'red' },
      ],
    });
    const groups = groupRows(
      [row('1', { m: ['x', 'y'] })],
      multi,
      { propertyId: 'm', hideEmpty: true },
      ctx,
    );
    expect(names(groups)).toEqual(['X:1', 'Y:1']);
    expect(groups[0]!.info.value).toEqual(['x']);
  });

  it('groups status by To-do / In progress / Complete', () => {
    const status = prop('st', 'status', {
      options: [
        { id: 'n', name: 'Not started', color: 'default', group: 'todo' },
        { id: 'r', name: 'Review', color: 'purple', group: 'inProgress' },
        { id: 'w', name: 'Working', color: 'blue', group: 'inProgress' },
      ],
    });
    const rows = [row('1', { st: 'w' }), row('2', { st: 'r' })];
    const groups = groupRows(rows, status, { propertyId: 'st', statusBucket: 'group' }, ctx);
    expect(names(groups)).toEqual(['No st:', 'To-do:', 'In progress:1,2', 'Complete:']);
  });

  it('buckets dates relative to today, or by month', () => {
    const date = prop('d', 'date');
    const rows = [
      row('a', { d: { start: '2026-10-04' } }),
      row('b', { d: { start: '2026-10-06' } }),
      row('c', { d: { start: '2026-08-01' } }),
      row('e', {}),
    ];
    expect(names(groupRows(rows, date, { propertyId: 'd' }, ctx))).toEqual([
      'No d:e',
      'Older:c',
      'Today:a',
      'Next 7 days:b',
    ]);
    const months = groupRows(rows, date, { propertyId: 'd', dateBucket: 'month' }, ctx);
    expect(names(months)).toEqual(['No d:e', 'August 2026:c', 'October 2026:a,b']);
    const days = groupRows(rows, date, { propertyId: 'd', dateBucket: 'day' }, ctx);
    expect(days[1]!.info.value).toEqual({ start: '2026-08-01' });
  });

  it('groups checkboxes, people, text and number ranges', () => {
    const rows = [
      row('1', { c: true, p: ['u1'], t: 'beta', n: 15 }),
      row('2', { t: 'Alpha', n: -2 }),
    ];
    expect(names(groupRows(rows, prop('c', 'checkbox'), { propertyId: 'c' }, ctx))).toEqual([
      'Checked:1',
      'Unchecked:2',
    ]);
    expect(names(groupRows(rows, prop('p', 'person'), { propertyId: 'p' }, ctx))).toEqual([
      'No p:2',
      'Ravi:1',
    ]);
    expect(names(groupRows(rows, prop('t', 'text'), { propertyId: 't' }, ctx))).toEqual([
      'Alpha:2',
      'beta:1',
    ]);
    expect(
      names(
        groupRows(rows, prop('t', 'text'), { propertyId: 't', textBucket: 'alphabetical' }, ctx),
      ),
    ).toEqual(['A:2', 'B:1']);
    expect(
      names(
        groupRows(
          rows,
          prop('n', 'number'),
          { propertyId: 'n', numberRange: { start: 0, end: 100, step: 10 } },
          ctx,
        ),
      ),
    ).toEqual(['< 0:2', '10 – 20:1']);
  });
});
