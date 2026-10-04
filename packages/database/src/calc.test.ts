import { describe, expect, it } from 'vitest';
import {
  calculate,
  calculationsFor,
  formatDateString,
  formatNumber,
  formatTimestamp,
} from './index';
import { prop, row } from './testing';

const NOW = new Date(2026, 9, 4, 12).getTime();
const ctx = { users: new Map<string, string>(), now: NOW };

describe('calculations', () => {
  const n = prop('n', 'number', { numberFormat: 'commas' });
  const rows = [
    row('1', { n: 1000, t: 'a', m: ['x', 'y'], c: true }),
    row('2', { n: 3, t: 'A' }),
    row('3', {}),
  ];

  it('counts and percentages', () => {
    const t = prop('t', 'text');
    expect(calculate(rows, t, 'countAll', ctx)).toBe('3');
    expect(calculate(rows, t, 'countEmpty', ctx)).toBe('1');
    expect(calculate(rows, t, 'countUnique', ctx)).toBe('1');
    expect(calculate(rows, t, 'percentNotEmpty', ctx)).toBe('66.7%');
    expect(calculate(rows, prop('m', 'multiSelect'), 'countValues', ctx)).toBe('2');
    expect(calculate(rows, prop('c', 'checkbox'), 'percentChecked', ctx)).toBe('33.3%');
  });

  it('number statistics in the property format', () => {
    expect(calculate(rows, n, 'sum', ctx)).toBe('1,003');
    expect(calculate(rows, n, 'average', ctx)).toBe('501.5');
    expect(calculate(rows, n, 'median', ctx)).toBe('501.5');
    expect(calculate(rows, n, 'range', ctx)).toBe('997');
    expect(calculate([], n, 'sum', ctx)).toBe('');
  });

  it('date earliest, latest and range', () => {
    const d = prop('d', 'date');
    const dated = [
      row('1', { d: { start: '2026-10-01' } }),
      row('2', { d: { start: '2026-10-15', end: '2026-10-22' } }),
    ];
    expect(calculate(dated, d, 'earliest', ctx)).toBe('Oct 1, 2026');
    expect(calculate(dated, d, 'latest', ctx)).toBe('Oct 22, 2026');
    expect(calculate(dated, d, 'dateRange', ctx)).toBe('3 weeks');
  });

  it('offers calculations by type', () => {
    expect(calculationsFor('checkbox').map((c) => c.id)).toContain('percentChecked');
    expect(calculationsFor('number').map((c) => c.id)).toContain('median');
    expect(calculationsFor('text').map((c) => c.id)).not.toContain('sum');
  });
});

describe('formats', () => {
  it('formats numbers', () => {
    expect(formatNumber(1234.5, { numberFormat: 'commas' })).toBe('1,234.5');
    expect(formatNumber(12, { numberFormat: 'percent' })).toBe('12%');
    expect(formatNumber(3, { numberFormat: 'dollar' })).toBe('$3.00');
    expect(formatNumber(3, { numberFormat: 'euro' })).toBe('€3.00');
    expect(formatNumber(2.5, { precision: 2 })).toBe('2.50');
  });

  it('formats dates and times', () => {
    const now = new Date(NOW);
    expect(formatDateString('2026-10-20', { dateFormat: 'dmy' }, now)).toBe('20/10/2026');
    expect(formatDateString('2026-10-20', { dateFormat: 'ymd' }, now)).toBe('2026/10/20');
    expect(formatDateString('2026-10-20T15:05', { timeFormat: '24h' }, now)).toBe(
      'Oct 20, 2026 15:05',
    );
    expect(formatDateString('2026-10-05', { dateFormat: 'relative' }, now)).toBe('Tomorrow');
    expect(formatDateString('2026-10-08', { dateFormat: 'relative' }, now)).toBe('Thursday');
    expect(formatDateString('2026-10-01', { dateFormat: 'relative' }, now)).toBe('Last Thursday');
    expect(formatTimestamp(NOW, { dateFormat: 'relative' }, now)).toBe('Today 12:00 PM');
  });
});
