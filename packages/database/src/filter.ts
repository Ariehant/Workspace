import { newId } from '@workspace/core';
import { dateFromString, dayOffset } from './format';
import { cellValue, isDateValue, propertyKind } from './properties';
import type {
  DisplayContext,
  Filter,
  FilterGroup,
  FilterRule,
  Property,
  PropertyType,
  Row,
} from './schema';

export type FilterOperator =
  | 'is'
  | 'isNot'
  | 'contains'
  | 'doesNotContain'
  | 'startsWith'
  | 'endsWith'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'lt'
  | 'gte'
  | 'lte'
  | 'isBefore'
  | 'isAfter'
  | 'isOnOrBefore'
  | 'isOnOrAfter'
  | 'isWithin'
  | 'isEmpty'
  | 'isNotEmpty';

/** What kind of value an operator takes, so the UI can offer the right input. */
export type FilterValueKind =
  'none' | 'text' | 'number' | 'options' | 'people' | 'date' | 'range' | 'boolean';

export interface OperatorInfo {
  id: FilterOperator;
  label: string;
  value: FilterValueKind;
}

/** A date to compare with: a fixed day, or one relative to today. */
export type DateTarget =
  | { kind: 'exact'; date: string }
  | {
      kind: 'relative';
      relative:
        | 'today'
        | 'tomorrow'
        | 'yesterday'
        | 'oneWeekAgo'
        | 'oneWeekFromNow'
        | 'oneMonthAgo'
        | 'oneMonthFromNow';
    };

/** "Is within": the past / next N units, or this calendar week / month / year. */
export interface DateRangeTarget {
  direction: 'past' | 'next' | 'this';
  amount: number;
  unit: 'day' | 'week' | 'month' | 'year';
}

/** The user who is looking, in person filters. */
export const ME = 'me';

const EMPTY_OPS: OperatorInfo[] = [
  { id: 'isEmpty', label: 'Is empty', value: 'none' },
  { id: 'isNotEmpty', label: 'Is not empty', value: 'none' },
];

const TEXT_OPS: OperatorInfo[] = [
  { id: 'contains', label: 'Contains', value: 'text' },
  { id: 'doesNotContain', label: 'Does not contain', value: 'text' },
  { id: 'is', label: 'Is', value: 'text' },
  { id: 'isNot', label: 'Is not', value: 'text' },
  { id: 'startsWith', label: 'Starts with', value: 'text' },
  { id: 'endsWith', label: 'Ends with', value: 'text' },
  ...EMPTY_OPS,
];

const NUMBER_OPS: OperatorInfo[] = [
  { id: 'eq', label: '=', value: 'number' },
  { id: 'neq', label: '≠', value: 'number' },
  { id: 'gt', label: '>', value: 'number' },
  { id: 'lt', label: '<', value: 'number' },
  { id: 'gte', label: '≥', value: 'number' },
  { id: 'lte', label: '≤', value: 'number' },
  ...EMPTY_OPS,
];

const DATE_OPS: OperatorInfo[] = [
  { id: 'is', label: 'Is', value: 'date' },
  { id: 'isBefore', label: 'Is before', value: 'date' },
  { id: 'isAfter', label: 'Is after', value: 'date' },
  { id: 'isOnOrBefore', label: 'Is on or before', value: 'date' },
  { id: 'isOnOrAfter', label: 'Is on or after', value: 'date' },
  { id: 'isWithin', label: 'Is within', value: 'range' },
  ...EMPTY_OPS,
];

const OPERATORS: Record<PropertyType, OperatorInfo[]> = {
  title: TEXT_OPS,
  text: TEXT_OPS,
  url: TEXT_OPS,
  email: TEXT_OPS,
  phone: TEXT_OPS,
  number: NUMBER_OPS,
  uniqueId: NUMBER_OPS.filter((o) => o.value !== 'none'),
  select: [
    { id: 'is', label: 'Is', value: 'options' },
    { id: 'isNot', label: 'Is not', value: 'options' },
    ...EMPTY_OPS,
  ],
  status: [
    { id: 'is', label: 'Is', value: 'options' },
    { id: 'isNot', label: 'Is not', value: 'options' },
    ...EMPTY_OPS,
  ],
  multiSelect: [
    { id: 'contains', label: 'Contains', value: 'options' },
    { id: 'doesNotContain', label: 'Does not contain', value: 'options' },
    ...EMPTY_OPS,
  ],
  person: [
    { id: 'contains', label: 'Contains', value: 'people' },
    { id: 'doesNotContain', label: 'Does not contain', value: 'people' },
    ...EMPTY_OPS,
  ],
  createdBy: [
    { id: 'contains', label: 'Is', value: 'people' },
    { id: 'doesNotContain', label: 'Is not', value: 'people' },
  ],
  lastEditedBy: [
    { id: 'contains', label: 'Is', value: 'people' },
    { id: 'doesNotContain', label: 'Is not', value: 'people' },
  ],
  date: DATE_OPS,
  createdTime: DATE_OPS.filter((o) => o.value !== 'none'),
  lastEditedTime: DATE_OPS.filter((o) => o.value !== 'none'),
  checkbox: [{ id: 'is', label: 'Is', value: 'boolean' }],
  files: EMPTY_OPS,
};

export function filterOperators(type: PropertyType): OperatorInfo[] {
  return OPERATORS[type] ?? TEXT_OPS;
}

export function operatorInfo(type: PropertyType, operator: string): OperatorInfo | undefined {
  return filterOperators(type).find((o) => o.id === operator);
}

/** A new rule for a property, with Notion's default operator. */
export function newFilterRule(property: Property): FilterRule {
  const first = filterOperators(property.type)[0]!;
  return {
    type: 'rule',
    id: newId(),
    propertyId: property.id,
    operator: first.id,
    value:
      property.type === 'checkbox'
        ? true
        : first.value === 'date'
          ? ({ kind: 'relative', relative: 'today' } satisfies DateTarget)
          : undefined,
  };
}

export function newFilterGroup(
  conjunction: 'and' | 'or' = 'and',
  filters: Filter[] = [],
): FilterGroup {
  return { type: 'group', id: newId(), conjunction, filters };
}

/** Whether a rule has what it needs to apply (incomplete rules don't filter). */
export function isRuleComplete(rule: FilterRule, property: Property): boolean {
  const info = operatorInfo(property.type, rule.operator);
  if (!info) return false;
  const v = rule.value;
  switch (info.value) {
    case 'none':
      return true;
    case 'text':
      return typeof v === 'string' && v !== '';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'options':
    case 'people':
      return Array.isArray(v) && v.length > 0;
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
      return typeof v === 'object' && v !== null && 'kind' in v;
    case 'range':
      return typeof v === 'object' && v !== null && 'direction' in v;
  }
}

// --- Evaluation ------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** Day number (days since the epoch, local) of a date. */
const dayNumber = (d: Date) =>
  Math.round(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / DAY_MS);

function targetDay(target: DateTarget, now: Date): number {
  if (target.kind === 'exact') return dayNumber(dateFromString(target.date));
  const shift = (days: number, months = 0) =>
    dayNumber(new Date(now.getFullYear(), now.getMonth() + months, now.getDate() + days));
  switch (target.relative) {
    case 'today':
      return shift(0);
    case 'tomorrow':
      return shift(1);
    case 'yesterday':
      return shift(-1);
    case 'oneWeekAgo':
      return shift(-7);
    case 'oneWeekFromNow':
      return shift(7);
    case 'oneMonthAgo':
      return shift(0, -1);
    case 'oneMonthFromNow':
      return shift(0, 1);
  }
}

/** First and last day (inclusive) of an "is within" range. */
export function rangeDays(range: DateRangeTarget, now: Date): [number, number] {
  const today = dayNumber(now);
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  if (range.direction === 'this') {
    switch (range.unit) {
      case 'day':
        return [today, today];
      case 'week': {
        const start = today - ((now.getDay() + 6) % 7); // weeks start on Monday
        return [start, start + 6];
      }
      case 'month':
        return [dayNumber(new Date(y, m, 1)), dayNumber(new Date(y, m + 1, 0))];
      case 'year':
        return [dayNumber(new Date(y, 0, 1)), dayNumber(new Date(y, 11, 31))];
    }
  }
  const n = Math.max(0, Math.floor(range.amount)) * (range.direction === 'past' ? -1 : 1);
  const other =
    range.unit === 'day'
      ? today + n
      : range.unit === 'week'
        ? today + 7 * n
        : range.unit === 'month'
          ? dayNumber(new Date(y, m + n, d))
          : dayNumber(new Date(y + n, m, d));
  return range.direction === 'past' ? [other, today] : [today, other];
}

/** The day a date-like cell falls on (its start, for ranges). */
function cellDay(value: unknown, type: PropertyType): number | null {
  if (type === 'createdTime' || type === 'lastEditedTime') {
    return typeof value === 'number' ? dayNumber(new Date(value)) : null;
  }
  return isDateValue(value) ? dayNumber(dateFromString(value.start)) : null;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : '');

function matchesRule(row: Row, rule: FilterRule, property: Property, ctx: DisplayContext): boolean {
  if (!isRuleComplete(rule, property)) return true;
  const kind = propertyKind(property.type);
  const value = cellValue(row, property);
  const empty = kind.isEmpty(value);
  const op = rule.operator as FilterOperator;
  if (op === 'isEmpty') return empty;
  if (op === 'isNotEmpty') return !empty;
  const now = new Date(ctx.now ?? Date.now());

  switch (property.type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone': {
      const text = lower(value);
      const q = lower(rule.value);
      switch (op) {
        case 'contains':
          return text.includes(q);
        case 'doesNotContain':
          return !text.includes(q);
        case 'is':
          return text === q;
        case 'isNot':
          return text !== q;
        case 'startsWith':
          return text.startsWith(q);
        case 'endsWith':
          return text.endsWith(q);
        default:
          return true;
      }
    }
    case 'number':
    case 'uniqueId': {
      const target = rule.value as number;
      if (empty) return op === 'neq';
      const n = value as number;
      switch (op) {
        case 'eq':
          return n === target;
        case 'neq':
          return n !== target;
        case 'gt':
          return n > target;
        case 'lt':
          return n < target;
        case 'gte':
          return n >= target;
        case 'lte':
          return n <= target;
        default:
          return true;
      }
    }
    case 'select':
    case 'status': {
      const ids = rule.value as string[];
      return op === 'isNot' ? !ids.includes(value as string) : ids.includes(value as string);
    }
    case 'multiSelect':
    case 'person': {
      const ids = (rule.value as string[]).map((id) => (id === ME ? (ctx.me ?? id) : id));
      const has = Array.isArray(value) && value.some((v) => ids.includes(v as string));
      return op === 'doesNotContain' ? !has : has;
    }
    case 'createdBy':
    case 'lastEditedBy': {
      const ids = (rule.value as string[]).map((id) => (id === ME ? (ctx.me ?? id) : id));
      const has = ids.includes(value as string);
      return op === 'doesNotContain' ? !has : has;
    }
    case 'checkbox':
      return (value === true) === rule.value;
    case 'date':
    case 'createdTime':
    case 'lastEditedTime': {
      const day = cellDay(value, property.type);
      if (day === null) return false;
      if (op === 'isWithin') {
        const [from, to] = rangeDays(rule.value as DateRangeTarget, now);
        return day >= from && day <= to;
      }
      const target = targetDay(rule.value as DateTarget, now);
      switch (op) {
        case 'is':
          return day === target;
        case 'isBefore':
          return day < target;
        case 'isAfter':
          return day > target;
        case 'isOnOrBefore':
          return day <= target;
        case 'isOnOrAfter':
          return day >= target;
        default:
          return true;
      }
    }
    default:
      return true;
  }
}

/** Whether a filter does anything: a complete rule on an existing property, or a group with one. */
function isActive(filter: Filter, properties: ReadonlyMap<string, Property>): boolean {
  if (filter.type === 'group') return filter.filters.some((f) => isActive(f, properties));
  const property = properties.get(filter.propertyId);
  return property !== undefined && isRuleComplete(filter, property);
}

/**
 * Whether a row passes a filter. Incomplete rules and rules on deleted properties
 * drop out (so an unfinished rule in an OR group doesn't let everything through).
 */
export function matchesFilter(
  row: Row,
  filter: Filter | null,
  properties: ReadonlyMap<string, Property>,
  ctx: DisplayContext,
): boolean {
  if (!filter || !isActive(filter, properties)) return true;
  if (filter.type === 'rule')
    return matchesRule(row, filter, properties.get(filter.propertyId)!, ctx);
  const active = filter.filters.filter((f) => isActive(f, properties));
  return filter.conjunction === 'and'
    ? active.every((f) => matchesFilter(row, f, properties, ctx))
    : active.some((f) => matchesFilter(row, f, properties, ctx));
}

/** Days relative to today, for display ("Today", "Tomorrow"). */
export function relativeDayLabel(target: DateTarget, now = new Date()): string {
  if (target.kind === 'exact') {
    const days = dayOffset(dateFromString(target.date), now);
    return days === 0 ? 'Today' : target.date;
  }
  return {
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    oneWeekAgo: 'One week ago',
    oneWeekFromNow: 'One week from now',
    oneMonthAgo: 'One month ago',
    oneMonthFromNow: 'One month from now',
  }[target.relative];
}

// --- Editing a filter tree ---------------------------------------------------------------

/** Replace the filter with `id` (rule or group) in a tree; `null` removes it. */
export function updateFilterTree(
  root: FilterGroup,
  id: string,
  update: (filter: Filter) => Filter | null,
): FilterGroup {
  const walk = (group: FilterGroup): FilterGroup => ({
    ...group,
    filters: group.filters.flatMap((f) => {
      if (f.id === id) {
        const next = update(f);
        return next ? [next] : [];
      }
      return f.type === 'group' ? [walk(f)] : [f];
    }),
  });
  return root.id === id ? (update(root) as FilterGroup) : walk(root);
}

/** Count of rules in a tree (for "3 rules" labels). */
export function countRules(filter: Filter | null): number {
  if (!filter) return 0;
  return filter.type === 'rule' ? 1 : filter.filters.reduce((n, f) => n + countRules(f), 0);
}
