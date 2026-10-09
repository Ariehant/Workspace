/**
 * Notion's filter and sort JSON for database queries, run against our rows: compound
 * `and`/`or` (nested two deep, as Notion allows), property conditions by type, and
 * timestamp conditions. Rows are computed snapshots (formulas, rollups and relations
 * filled in).
 */
import {
  TITLE_PROPERTY_ID,
  cellValue,
  compareRows,
  effectiveType,
  isDateValue,
  optionsOf,
  propertyKind,
  relationIds,
  type Property,
  type PropertyType,
  type Row,
} from '@workspace/database';
import { invalid } from './errors';
import { parseId } from './ids';
import { apiType, parseDateString, propertyKeys } from './properties';

export type RowTest = (row: Row) => boolean;

const MAX_DEPTH = 2;
const DAY_MS = 24 * 3600_000;

const asObject = (v: unknown, where: string): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw invalid(`${where} should be an object.`);
  return v as Record<string, unknown>;
};

/** A property by name or id. */
export function findProperty(properties: readonly Property[], key: unknown): Property | undefined {
  if (typeof key !== 'string') return undefined;
  const keys = propertyKeys(properties);
  return (
    properties.find((p) => keys.get(p.id) === key) ??
    properties.find((p) => p.id === key || (key === 'title' && p.id === TITLE_PROPERTY_ID))
  );
}

// --- Conditions by kind --------------------------------------------------------------

type Condition = [op: string, value: unknown];

function condition(raw: unknown, where: string): Condition {
  const o = asObject(raw, where);
  const keys = Object.keys(o);
  if (keys.length !== 1) throw invalid(`${where} should have exactly one condition.`);
  return [keys[0]!, o[keys[0]!]];
}

const isEmptyCheck = (op: string, value: unknown, where: string): boolean | null => {
  if (op !== 'is_empty' && op !== 'is_not_empty') return null;
  if (value !== true) throw invalid(`${where}.${op} should be true.`);
  return op === 'is_empty';
};

function textTest([op, target]: Condition, where: string): (v: unknown) => boolean {
  const empty = isEmptyCheck(op, target, where);
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  if (empty !== null) return (v) => (text(v) === '') === empty;
  if (typeof target !== 'string') throw invalid(`${where}.${op} should be a string.`);
  const lower = target.toLowerCase();
  switch (op) {
    case 'equals':
      return (v) => text(v) === target;
    case 'does_not_equal':
      return (v) => text(v) !== target;
    case 'contains':
      return (v) => text(v).toLowerCase().includes(lower);
    case 'does_not_contain':
      return (v) => !text(v).toLowerCase().includes(lower);
    case 'starts_with':
      return (v) => text(v).toLowerCase().startsWith(lower);
    case 'ends_with':
      return (v) => text(v).toLowerCase().endsWith(lower);
  }
  throw invalid(`${where}: "${op}" isn't a text condition.`);
}

function numberTest([op, target]: Condition, where: string): (v: unknown) => boolean {
  const empty = isEmptyCheck(op, target, where);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (empty !== null) return (v) => (num(v) === null) === empty;
  if (typeof target !== 'number') throw invalid(`${where}.${op} should be a number.`);
  const cmp = (f: (n: number) => boolean) => (v: unknown) => {
    const n = num(v);
    return n !== null && f(n);
  };
  switch (op) {
    case 'equals':
      return cmp((n) => n === target);
    case 'does_not_equal':
      return (v) => num(v) !== target;
    case 'greater_than':
      return cmp((n) => n > target);
    case 'less_than':
      return cmp((n) => n < target);
    case 'greater_than_or_equal_to':
      return cmp((n) => n >= target);
    case 'less_than_or_equal_to':
      return cmp((n) => n <= target);
  }
  throw invalid(`${where}: "${op}" isn't a number condition.`);
}

function checkboxTest([op, target]: Condition, where: string): (v: unknown) => boolean {
  if (typeof target !== 'boolean') throw invalid(`${where}.${op} should be a boolean.`);
  if (op === 'equals') return (v) => (v === true) === target;
  if (op === 'does_not_equal') return (v) => (v === true) !== target;
  throw invalid(`${where}: "${op}" isn't a checkbox condition.`);
}

/** Select and status: by option name (or id). */
function optionTest(p: Property, [op, target]: Condition, where: string): (v: unknown) => boolean {
  const empty = isEmptyCheck(op, target, where);
  if (empty !== null) return (v) => (typeof v !== 'string' || !v) === empty;
  if (typeof target !== 'string') throw invalid(`${where}.${op} should be a string.`);
  const ids = optionsOf(p)
    .filter((o) => o.name === target || o.id === target)
    .map((o) => o.id);
  if (op === 'equals') return (v) => ids.includes(v as string);
  if (op === 'does_not_equal') return (v) => !ids.includes(v as string);
  throw invalid(`${where}: "${op}" isn't a ${apiType(p.type)} condition.`);
}

/** Lists (multi-select by option name, people and relations by id). */
function listTest(
  [op, target]: Condition,
  where: string,
  items: (v: unknown) => string[],
  resolve: (target: string) => string[],
): (v: unknown) => boolean {
  const empty = isEmptyCheck(op, target, where);
  if (empty !== null) return (v) => (items(v).length === 0) === empty;
  if (typeof target !== 'string') throw invalid(`${where}.${op} should be a string.`);
  const wanted = resolve(target);
  const has = (v: unknown) => items(v).some((x) => wanted.includes(x));
  if (op === 'contains') return has;
  if (op === 'does_not_contain') return (v) => !has(v);
  throw invalid(`${where}: "${op}" isn't a condition for lists.`);
}

/** A cell's time: date values (their start), and created / edited times (ms). */
function timeOf(v: unknown): { ms: number; day: string } | null {
  if (typeof v === 'number') return { ms: v, day: new Date(v).toISOString().slice(0, 10) };
  if (isDateValue(v)) {
    const s = v.start;
    const ms = Date.parse(s.length > 10 ? `${s}:00Z` : `${s}T00:00:00Z`);
    return { ms, day: s.slice(0, 10) };
  }
  return null;
}

const RELATIVE: Record<string, (now: number) => [number, number]> = {
  past_week: (now) => [now - 7 * DAY_MS, now],
  past_month: (now) => [now - 30 * DAY_MS, now],
  past_year: (now) => [now - 365 * DAY_MS, now],
  next_week: (now) => [now, now + 7 * DAY_MS],
  next_month: (now) => [now, now + 30 * DAY_MS],
  next_year: (now) => [now, now + 365 * DAY_MS],
  this_week: (now) => {
    const d = new Date(now);
    const monday =
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      ((d.getUTCDay() + 6) % 7) * DAY_MS;
    return [monday, monday + 7 * DAY_MS - 1];
  },
};

function dateTest([op, target]: Condition, where: string, now: number): (v: unknown) => boolean {
  const empty = isEmptyCheck(op, target, where);
  if (empty !== null) return (v) => (timeOf(v) === null) === empty;
  const relative = RELATIVE[op];
  if (relative) {
    const [from, to] = relative(now);
    return (v) => {
      const t = timeOf(v);
      return t !== null && t.ms >= from && t.ms <= to;
    };
  }
  const stored = parseDateString(target, `${where}.${op}`);
  const dayOnly = stored.length === 10;
  const at = Date.parse(dayOnly ? `${stored}T00:00:00Z` : `${stored}:00Z`);
  // A date-only target compares days; a time compares instants.
  const compare = (t: { ms: number; day: string }) =>
    dayOnly ? (t.day < stored ? -1 : t.day > stored ? 1 : 0) : Math.sign(t.ms - at);
  const test = (f: (c: number) => boolean) => (v: unknown) => {
    const t = timeOf(v);
    return t !== null && f(compare(t));
  };
  switch (op) {
    case 'equals':
      return test((c) => c === 0);
    case 'before':
      return test((c) => c < 0);
    case 'after':
      return test((c) => c > 0);
    case 'on_or_before':
      return test((c) => c <= 0);
    case 'on_or_after':
      return test((c) => c >= 0);
  }
  throw invalid(`${where}: "${op}" isn't a date condition.`);
}

/** A test on a value of a given type (formula and rollup results, and properties). */
function valueTest(
  type: PropertyType,
  p: Property | null,
  raw: unknown,
  where: string,
  now: number,
): (v: unknown) => boolean {
  switch (type) {
    case 'title':
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return textTest(condition(raw, where), where);
    case 'number':
    case 'uniqueId':
      return numberTest(condition(raw, where), where);
    case 'checkbox':
      return checkboxTest(condition(raw, where), where);
    case 'select':
    case 'status':
      return optionTest(p!, condition(raw, where), where);
    case 'multiSelect': {
      const options = optionsOf(p!);
      return listTest(
        condition(raw, where),
        where,
        (v) => (Array.isArray(v) ? (v as string[]) : []),
        (t) => options.filter((o) => o.name === t || o.id === t).map((o) => o.id),
      );
    }
    case 'person':
    case 'createdBy':
    case 'lastEditedBy':
      return listTest(
        condition(raw, where),
        where,
        (v) => (Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : []),
        (t) => [parseId(t) ?? t],
      );
    case 'relation':
      return listTest(condition(raw, where), where, relationIds, (t) => [parseId(t) ?? t]);
    case 'files': {
      const [op, target] = condition(raw, where);
      const empty = isEmptyCheck(op, target, where);
      if (empty === null) throw invalid(`${where}: "${op}" isn't a files condition.`);
      return (v) => (!Array.isArray(v) || v.length === 0) === empty;
    }
    case 'date':
    case 'createdTime':
    case 'lastEditedTime':
      return dateTest(condition(raw, where), where, now);
    default:
      throw invalid(`${where}: ${p ? apiType(p.type) : type} properties can't be filtered.`);
  }
}

const RESULT_TYPES: Record<string, PropertyType> = {
  string: 'text',
  number: 'number',
  checkbox: 'checkbox',
  date: 'date',
};

function propertyTest(
  p: Property,
  o: Record<string, unknown>,
  where: string,
  now: number,
): RowTest {
  const keys = Object.keys(o).filter((k) => k !== 'property' && k !== 'type');
  if (keys.length !== 1)
    throw invalid(`${where} should have one condition, under the property's type.`);
  const key = keys[0]!;
  const raw = o[key];
  let test: (v: unknown) => boolean;
  if (p.type === 'formula' || p.type === 'rollup') {
    if (key !== apiType(p.type))
      throw invalid(`${where}.${key}: ${p.name} is a ${apiType(p.type)}.`);
    const inner = asObject(raw, `${where}.${key}`);
    const innerKey = Object.keys(inner)[0] ?? '';
    const type = RESULT_TYPES[innerKey];
    if (!type) {
      throw invalid(
        `${where}.${key}: only string, number, checkbox and date conditions are supported.`,
      );
    }
    if (type !== effectiveType(p) && !(type === 'text' && effectiveType(p) === 'text')) {
      throw invalid(`${where}.${key}.${innerKey} doesn't match the result of ${p.name}.`);
    }
    test = valueTest(type, p, inner[innerKey], `${where}.${key}.${innerKey}`, now);
  } else {
    // Text conditions work on any text type (as in Notion: rich_text on a title).
    const textual = new Set(['title', 'rich_text', 'url', 'email', 'phone_number']);
    const own = apiType(p.type);
    if (key !== own && !(textual.has(key) && textual.has(own))) {
      throw invalid(`${where}.${key}: ${p.name} is a ${own} property.`);
    }
    test = valueTest(p.type, p, raw, `${where}.${key}`, now);
  }
  return (row) => test(cellValue(row, p));
}

function compile(
  raw: unknown,
  properties: readonly Property[],
  where: string,
  depth: number,
  now: number,
): RowTest {
  const o = asObject(raw, where);
  for (const conj of ['and', 'or'] as const) {
    if (!(conj in o)) continue;
    if (depth >= MAX_DEPTH)
      throw invalid(`${where}: filters nest at most ${MAX_DEPTH} levels deep.`);
    const list = o[conj];
    if (!Array.isArray(list)) throw invalid(`${where}.${conj} should be an array.`);
    if (list.length > 100) throw invalid(`${where}.${conj} should have at most 100 filters.`);
    const tests = list.map((f, i) =>
      compile(f, properties, `${where}.${conj}[${i}]`, depth + 1, now),
    );
    return conj === 'and'
      ? (row) => tests.every((t) => t(row))
      : (row) => tests.some((t) => t(row));
  }
  if (typeof o.timestamp === 'string') {
    const type =
      o.timestamp === 'created_time'
        ? 'createdTime'
        : o.timestamp === 'last_edited_time'
          ? 'lastEditedTime'
          : null;
    if (!type) throw invalid(`${where}.timestamp should be "created_time" or "last_edited_time".`);
    const test = dateTest(condition(o[o.timestamp], `${where}.${o.timestamp}`), where, now);
    return (row) => test(type === 'createdTime' ? row.createdAt : row.updatedAt);
  }
  const p = findProperty(properties, o.property);
  if (!p) throw invalid(`${where}.property: no property ${JSON.stringify(o.property)}.`);
  return propertyTest(p, o, where, now);
}

/** A query's `filter`, as a test on rows. */
export function compileFilter(
  filter: unknown,
  properties: readonly Property[],
  now = Date.now(),
): RowTest {
  if (filter === undefined || filter === null) return () => true;
  return compile(filter, properties, 'body.filter', 0, now);
}

/** A query's `sorts`, as a comparator (manual order breaks ties). */
export function compileSorts(
  sorts: unknown,
  properties: readonly Property[],
): (a: Row, b: Row) => number {
  if (sorts === undefined || sorts === null) return () => 0;
  if (!Array.isArray(sorts)) throw invalid('body.sorts should be an array.');
  if (sorts.length > 100) throw invalid('body.sorts should have at most 100 items.');
  const list = sorts.map((raw, i) => {
    const where = `body.sorts[${i}]`;
    const o = asObject(raw, where);
    const direction =
      o.direction === 'descending' ? 'desc' : o.direction === 'ascending' ? 'asc' : null;
    if (!direction) throw invalid(`${where}.direction should be "ascending" or "descending".`);
    if (o.timestamp !== undefined) {
      const type =
        o.timestamp === 'created_time'
          ? 'createdTime'
          : o.timestamp === 'last_edited_time'
            ? 'lastEditedTime'
            : null;
      if (!type)
        throw invalid(`${where}.timestamp should be "created_time" or "last_edited_time".`);
      const property: Property = { id: `_${type}`, name: type, type, config: {}, sortKey: '' };
      return { property, direction } as const;
    }
    const property = findProperty(properties, o.property);
    if (!property) throw invalid(`${where}.property: no property ${JSON.stringify(o.property)}.`);
    if (!propertyKind(property.type).compare)
      throw invalid(`${where}: ${property.name} can't be sorted.`);
    return { property, direction } as const;
  });
  return (a, b) => compareRows(a, b, list, { users: new Map() });
}
