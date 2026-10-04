import { describe, expect, it } from 'vitest';
import {
  ME,
  countRules,
  matchesFilter,
  newFilterGroup,
  newFilterRule,
  rangeDays,
  updateFilterTree,
  type Filter,
  type FilterRule,
  type Property,
} from './index';
import { prop, row } from './testing';

// Sunday Oct 4, 2026, noon.
const NOW = new Date(2026, 9, 4, 12).getTime();
const ctx = { users: new Map([['u1', 'Ravi']]), me: 'u1', now: NOW };

const props: Property[] = [
  prop('title', 'title'),
  prop('n', 'number'),
  prop('s', 'select', { options: [{ id: 'a', name: 'A', color: 'red' }] }),
  prop('m', 'multiSelect'),
  prop('d', 'date'),
  prop('c', 'checkbox'),
  prop('p', 'person'),
  prop('ct', 'createdTime'),
];
const byId = new Map(props.map((p) => [p.id, p]));
const rule = (propertyId: string, operator: string, value?: unknown): FilterRule => ({
  type: 'rule',
  id: `${propertyId}-${operator}`,
  propertyId,
  operator,
  value,
});
const match = (values: Record<string, unknown>, f: Filter, extra = {}) =>
  matchesFilter(row('r', values, { title: 'Servo Motor', ...extra }), f, byId, ctx);

describe('filters', () => {
  it('matches text case-insensitively', () => {
    expect(match({}, rule('title', 'contains', 'motor'))).toBe(true);
    expect(match({}, rule('title', 'doesNotContain', 'motor'))).toBe(false);
    expect(match({}, rule('title', 'startsWith', 'servo'))).toBe(true);
    expect(match({}, rule('title', 'endsWith', 'servo'))).toBe(false);
    expect(match({}, rule('title', 'is', 'servo motor'))).toBe(true);
    expect(match({}, rule('title', 'isEmpty'))).toBe(false);
  });

  it('compares numbers; empty cells only pass "≠" and "is empty"', () => {
    expect(match({ n: 5 }, rule('n', 'gt', 3))).toBe(true);
    expect(match({ n: 5 }, rule('n', 'lte', 4))).toBe(false);
    expect(match({}, rule('n', 'gt', 3))).toBe(false);
    expect(match({}, rule('n', 'neq', 3))).toBe(true);
    expect(match({}, rule('n', 'isEmpty'))).toBe(true);
  });

  it('matches options, people (with "me") and checkboxes', () => {
    expect(match({ s: 'a' }, rule('s', 'is', ['a', 'b']))).toBe(true);
    expect(match({ s: 'a' }, rule('s', 'isNot', ['a']))).toBe(false);
    expect(match({ m: ['x', 'y'] }, rule('m', 'contains', ['y']))).toBe(true);
    expect(match({ m: ['x'] }, rule('m', 'doesNotContain', ['x']))).toBe(false);
    expect(match({ p: ['u1'] }, rule('p', 'contains', [ME]))).toBe(true);
    expect(match({ c: true }, rule('c', 'is', true))).toBe(true);
    expect(match({}, rule('c', 'is', false))).toBe(true);
  });

  it('compares dates by day, including relative ones', () => {
    const today = { kind: 'relative', relative: 'today' };
    expect(match({ d: { start: '2026-10-04T08:00' } }, rule('d', 'is', today))).toBe(true);
    expect(match({ d: { start: '2026-10-03' } }, rule('d', 'isBefore', today))).toBe(true);
    expect(
      match(
        { d: { start: '2026-10-11' } },
        rule('d', 'is', { kind: 'relative', relative: 'oneWeekFromNow' }),
      ),
    ).toBe(true);
    expect(
      match(
        { d: { start: '2026-10-20' } },
        rule('d', 'isOnOrAfter', { kind: 'exact', date: '2026-10-20' }),
      ),
    ).toBe(true);
    const past7 = { direction: 'past', amount: 7, unit: 'day' };
    expect(match({ d: { start: '2026-09-28' } }, rule('d', 'isWithin', past7))).toBe(true);
    expect(match({ d: { start: '2026-09-26' } }, rule('d', 'isWithin', past7))).toBe(false);
    expect(match({}, rule('ct', 'is', today), { createdAt: NOW - 3600_000 })).toBe(true);
    expect(match({}, rule('d', 'is', today))).toBe(false);
  });

  it('computes "is within" calendar ranges (weeks start on Monday)', () => {
    const day = (y: number, m: number, d: number) =>
      Math.round(new Date(y, m, d).getTime() / 86_400_000);
    const now = new Date(NOW);
    expect(rangeDays({ direction: 'this', amount: 0, unit: 'week' }, now)).toEqual([
      day(2026, 8, 28),
      day(2026, 9, 4),
    ]);
    expect(rangeDays({ direction: 'next', amount: 1, unit: 'month' }, now)).toEqual([
      day(2026, 9, 4),
      day(2026, 10, 4),
    ]);
  });

  it('ignores incomplete rules and rules on deleted properties', () => {
    expect(match({}, rule('title', 'contains', ''))).toBe(true);
    expect(match({}, rule('s', 'is', []))).toBe(true);
    expect(match({}, rule('gone', 'contains', 'x'))).toBe(true);
  });

  it('drops incomplete rules from OR groups instead of matching everything', () => {
    const f = newFilterGroup('or', [rule('s', 'is', []), rule('title', 'contains', 'zzz')]);
    expect(match({}, f)).toBe(false);
    expect(match({}, newFilterGroup('or', [rule('s', 'is', [])]))).toBe(true);
  });

  it('nests AND / OR groups', () => {
    const f = newFilterGroup('and', [
      rule('n', 'gt', 1),
      newFilterGroup('or', [rule('s', 'is', ['a']), rule('c', 'is', true)]),
    ]);
    expect(match({ n: 2, s: 'a' }, f)).toBe(true);
    expect(match({ n: 2, c: true }, f)).toBe(true);
    expect(match({ n: 2 }, f)).toBe(false);
    expect(match({ n: 0, s: 'a' }, f)).toBe(false);
    expect(countRules(f)).toBe(3);
  });

  it('edits a filter tree by id', () => {
    const inner = rule('n', 'gt', 1);
    const root = newFilterGroup('and', [newFilterGroup('or', [inner]), rule('c', 'is', true)]);
    const changed = updateFilterTree(root, inner.id, (f) => ({ ...f, value: 9 }) as Filter);
    expect(JSON.stringify(changed)).toContain('"value":9');
    const removed = updateFilterTree(root, inner.id, () => null);
    expect(countRules(removed)).toBe(1);
  });

  it('starts new rules with sensible defaults', () => {
    expect(newFilterRule(prop('x', 'text'))).toMatchObject({ operator: 'contains' });
    expect(newFilterRule(prop('x', 'checkbox'))).toMatchObject({ operator: 'is', value: true });
    expect(newFilterRule(prop('x', 'date'))).toMatchObject({
      operator: 'is',
      value: { kind: 'relative', relative: 'today' },
    });
  });
});
