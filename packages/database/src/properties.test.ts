import { describe, expect, it } from 'vitest';
import { cellText, propertyKind, rowPropertiesText, type Property, type Row } from './index';

const ctx = { users: new Map([['u1', 'Ravi']]) };
const prop = (type: Property['type'], config: Property['config'] = {}): Property => ({
  id: 'p',
  name: 'P',
  type,
  config,
  sortKey: 'a1',
});
const row = (values: Record<string, unknown>, extra: Partial<Row> = {}): Row => ({
  id: 'r',
  title: 'Row',
  icon: null,
  cover: null,
  sortKey: 'a0',
  createdAt: Date.UTC(2026, 9, 4, 12),
  createdBy: 'u1',
  updatedAt: 0,
  updatedBy: null,
  uid: 7,
  trashedAt: null,
  fullWidth: false,
  smallText: false,
  font: 'default',
  locked: false,
  isTemplate: false,
  values,
  ...extra,
});

const options = [
  { id: 'a', name: 'Alpha', color: 'red' as const },
  { id: 'b', name: 'Beta', color: 'blue' as const },
];

describe('property types', () => {
  it('shows values as text', () => {
    expect(cellText(row({ p: 3.5 }), prop('number'), ctx)).toBe('3.5');
    expect(cellText(row({ p: ['b', 'a'] }), prop('multiSelect', { options }), ctx)).toBe(
      'Beta, Alpha',
    );
    expect(cellText(row({ p: { start: '2026-10-04' } }), prop('date'), ctx)).toBe('Oct 4, 2026');
    expect(
      cellText(row({ p: { start: '2026-10-04T15:30', end: '2026-10-05' } }), prop('date'), ctx),
    ).toBe('Oct 4, 2026 3:30 PM → Oct 5, 2026');
    expect(cellText(row({ p: ['u1'] }), prop('person'), ctx)).toBe('Ravi');
    expect(cellText(row({}), prop('createdBy'), ctx)).toBe('Ravi');
    expect(cellText(row({}), prop('uniqueId', { prefix: 'TASK' }), ctx)).toBe('TASK-7');
    expect(cellText(row({}), prop('uniqueId'), ctx)).toBe('7');
    expect(cellText(row({}), prop('text'), ctx)).toBe('');
    expect(cellText(row({}), prop('title'), ctx)).toBe('Row');
  });

  it('parses text into values', () => {
    const parse = (type: Property['type'], text: string, config = {}) =>
      propertyKind(type).parse(text, prop(type, config), ctx);
    expect(parse('number', '$1,234.5').value).toBe(1234.5);
    expect(parse('number', 'abc').value).toBe(null);
    expect(parse('checkbox', 'Yes').value).toBe(true);
    expect(parse('checkbox', 'nope').value).toBe(false);
    expect(parse('date', '2026-10-04').value).toEqual({ start: '2026-10-04' });
    expect(parse('date', '2026-10-04 09:15 → 2026-10-06').value).toEqual({
      start: '2026-10-04T09:15',
      end: '2026-10-06',
    });
    expect(parse('person', 'ravi').value).toEqual(['u1']);
    expect(parse('files', 'https://x.org/a/b.pdf?x=1').value).toEqual([
      { url: 'https://x.org/a/b.pdf?x=1', name: 'b.pdf' },
    ]);
    const multi = parse('multiSelect', 'alpha, Gamma, alpha', { options });
    expect(multi.newOptions?.map((o) => o.name)).toEqual(['Gamma']);
    expect(multi.value).toEqual(['a', multi.newOptions![0]!.id]);
  });

  it('orders select values by option order and status by group', () => {
    const select = prop('select', { options });
    expect(propertyKind('select').compare('b', 'a', select, ctx)).toBeGreaterThan(0);
    const status = prop('status', {
      options: [
        { id: 'd', name: 'Done', color: 'green', group: 'complete' },
        { id: 't', name: 'Todo', color: 'default', group: 'todo' },
      ],
    });
    expect(propertyKind('status').compare('d', 't', status, ctx)).toBeGreaterThan(0);
    expect(propertyKind('text').compare('item 10', 'item 9', prop('text'), ctx)).toBeGreaterThan(0);
  });

  it('collects property text for search', () => {
    const tags = { ...prop('multiSelect', { options }), id: 'tags' };
    const note = { ...prop('text'), id: 'note' };
    expect(rowPropertiesText(row({ tags: ['a'], note: 'torque' }), [tags, note], ctx)).toBe(
      'Alpha\ntorque',
    );
  });
});
