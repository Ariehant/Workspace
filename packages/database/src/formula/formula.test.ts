import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  FormulaCache,
  addProperty,
  addRow,
  checkFormula,
  compileFormulas,
  initDatabase,
  readDatabase,
  renameInFormula,
  renameProperty,
  runView,
  setPropertyConfig,
  typeName,
  type Property,
  type Row,
} from '../index';
import { prop, row as makeRow } from '../testing';
import { check, evaluate } from './compile';
import { CASES } from './formula.cases';
import { propertyFType, propertyFValue } from './engine';
import { parse } from './parser';
import { FormulaError, isDate, isPerson, type FValue } from './types';

const NOW = new Date(2026, 9, 4, 12, 0).getTime();
const ctx = { users: new Map([['u1', 'Ravi']]), me: 'u1', now: NOW };

const PROPS: Property[] = [
  prop('title', 'title', {}, 'Name'),
  prop('price', 'number', {}, 'Price'),
  prop('qty', 'number', {}, 'Qty'),
  prop('empty', 'number', {}, 'Empty'),
  prop(
    'tags',
    'multiSelect',
    {
      options: [
        { id: 'a', name: 'Actuator', color: 'red' },
        { id: 'm', name: 'Metal', color: 'gray' },
      ],
    },
    'Tags',
  ),
  prop('etags', 'multiSelect', {}, 'Empty tags'),
  prop(
    'status',
    'status',
    { options: [{ id: 'ip', name: 'In progress', color: 'blue', group: 'inProgress' }] },
    'Status',
  ),
  prop('due', 'date', {}, 'Due'),
  prop('window', 'date', {}, 'Window'),
  prop('meeting', 'date', {}, 'Meeting'),
  prop('edate', 'date', {}, 'Empty date'),
  prop('done', 'checkbox', {}, 'Done'),
  prop('notes', 'text', {}, 'Notes'),
  prop('owner', 'person', {}, 'Owner'),
  prop('by', 'createdBy', {}, 'Created by'),
  prop('ct', 'createdTime', {}, 'Created time'),
  prop('id', 'uniqueId', {}, 'ID'),
  prop('url', 'url', {}, 'URL'),
  prop('files', 'files', {}, 'Files'),
];

const ROW: Row = makeRow(
  'row-1',
  {
    price: 12.5,
    qty: 4,
    tags: ['a', 'm'],
    status: 'ip',
    due: { start: '2026-10-20' },
    window: { start: '2026-10-01', end: '2026-10-15' },
    meeting: { start: '2026-10-05T14:30' },
    done: true,
    notes: '  Torque 13 kg·cm  ',
    owner: ['u1'],
    url: 'https://example.com',
    files: [{ id: 'f.pdf', name: 'spec.pdf' }],
  },
  {
    title: 'Servo motor',
    createdBy: 'u1',
    createdAt: new Date(2026, 9, 1, 9, 0).getTime(),
    uid: 7,
  },
);

const byName = new Map(PROPS.map((p) => [p.name, p]));
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (ms: number, time: boolean) => {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return time ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
};

/** Comparable form of a result (see formula.cases.ts). */
function norm(v: FValue): unknown {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e9) / 1e9 : v;
  if (Array.isArray(v)) return v.map(norm);
  if (v !== null && isDate(v)) {
    return `D:${iso(v.start, v.time)}${v.end !== null ? `→${iso(v.end, v.time)}` : ''}`;
  }
  if (v !== null && isPerson(v)) return `P:${v.name}`;
  return v;
}

function run(source: string): unknown {
  try {
    const node = parse(source);
    check(node, {
      prop: (name) => (byName.has(name) ? propertyFType(byName.get(name)!) : undefined),
    });
    return norm(
      evaluate(node, {
        prop: (name) => (byName.has(name) ? propertyFValue(ROW, byName.get(name)!, ctx) : null),
        page: { id: ROW.id, title: ROW.title },
        now: NOW,
      }),
    );
  } catch (error) {
    if (error instanceof FormulaError) return 'ERR';
    throw error;
  }
}

describe(`formula fixtures (${CASES.length})`, () => {
  it.each(CASES)('%s', (source, expected) => {
    expect(run(source)).toEqual(expected);
  });
});

const ERRORS: [string, RegExp, number?][] = [
  ['1 +', /end of formula/],
  ['"a" * 2', /needs numbers/, 0],
  ['prop("Nope")', /No property named "Nope"/, 5],
  ['unknownFn(1)', /Unknown function "unknownFn"/, 0],
  ['abs(1, 2)', /takes 1 argument/],
  ['if(1, 2, 3)', /needs a boolean/, 3],
  ['current + 1', /only works inside/],
  ['x + 1', /Unknown name "x"/],
  ['1 < "a"', /compare/],
  ['"abc', /closing quote/],
  ['round("a")', /needs a number/],
  ['filter([1, 2], current)', /needs a boolean/],
  ['(1 + 2', /Expected "\)"/],
  ['1 2', /Unexpected "2"/, 2],
  ['pi', /needs parentheses/],
  ['let(1, 2, 3)', /Expected a name/],
  ['dateAdd(1, 2, "days")', /needs a date/],
  ['prop(1)', /name of a property/],
  ['not 5', /needs a boolean/],
  ['name(1)', /needs a person/],
  ['and(1)', /boolean/],
  ['[1, 2].nope()', /Unknown function "nope"/],
  ['1 ? 2 : 3', /condition must be a boolean/],
  ['prop("Done") + 1', /Can't add boolean and number/],
  ['@', /Unexpected character/],
  ['substring("a")', /takes 2 to 3 arguments/],
  ['slice("text", 1)', /needs a list/],
];

describe('formula errors', () => {
  it.each(ERRORS)('%s', (source, message, at) => {
    const result = checkFormula(source, PROPS);
    expect(result.error?.message).toMatch(message);
    if (at !== undefined) expect(result.error?.span.start).toBe(at);
  });

  it('infers result types', () => {
    const typeOf = (s: string) => typeName(checkFormula(s, PROPS).type!);
    expect(typeOf('prop("Price") * 2')).toBe('number');
    expect(typeOf('prop("Tags")')).toBe('list of text');
    expect(typeOf('if(true, 1, "a")')).toBe('any');
    expect(typeOf('now()')).toBe('date');
    expect(typeOf('prop("Tags").map(length(current))')).toBe('list of number');
    expect(typeOf('prop("Owner").first()')).toBe('person');
  });
});

describe('formula properties', () => {
  function setup() {
    const doc = new Y.Doc();
    initDatabase(doc, { databaseId: 'db' });
    const price = addProperty(doc, { name: 'Price', type: 'number' });
    const qty = addProperty(doc, { name: 'Qty', type: 'number' });
    const total = addProperty(doc, {
      name: 'Total',
      type: 'formula',
      config: { expression: 'prop("Price") * prop("Qty")' },
    });
    const label = addProperty(doc, {
      name: 'Label',
      type: 'formula',
      config: { expression: 'prop("Name") + ": " + format(prop("Total"))' },
    });
    const a = addRow(doc, { actor: null, title: 'A', values: { [price]: 2, [qty]: 3 } });
    addRow(doc, { actor: null, title: 'B', values: { [price]: 10, [qty]: 1 } });
    return { doc, price, qty, total, label, a };
  }

  it('compute values in dependency order, with result types', () => {
    const { doc, total, label } = setup();
    const snapshot = new FormulaCache().apply(readDatabase(doc), ctx);
    expect(snapshot.rows.map((r) => r.values[total])).toEqual([6, 10]);
    expect(snapshot.rows.map((r) => r.values[label])).toEqual(['A: 6', 'B: 10']);
    expect(snapshot.properties.find((p) => p.id === total)?.config.resultType).toBe('number');
    expect(snapshot.properties.find((p) => p.id === label)?.config.resultType).toBe('text');
  });

  it('can be sorted and filtered by their result', () => {
    const { doc, total } = setup();
    const view = readDatabase(doc).views[0]!;
    const snapshot = new FormulaCache().apply(readDatabase(doc), ctx);
    const sorted = runView(
      snapshot,
      { ...view, sorts: [{ propertyId: total, direction: 'desc' }] },
      ctx,
    );
    expect(sorted.rows.map((r) => r.title)).toEqual(['B', 'A']);
    const filtered = runView(
      snapshot,
      {
        ...view,
        filter: {
          type: 'group',
          id: 'g',
          conjunction: 'and',
          filters: [{ type: 'rule', id: 'r', propertyId: total, operator: 'lt', value: 8 }],
        },
      },
      ctx,
    );
    expect(filtered.rows.map((r) => r.title)).toEqual(['A']);
  });

  it('reuses results for unchanged rows', () => {
    const { doc } = setup();
    const cache = new FormulaCache();
    const first = cache.apply(readDatabase(doc), ctx);
    const again = cache.apply(
      { ...readDatabase(doc), properties: first.properties.map((p) => ({ ...p })) },
      ctx,
    );
    expect(again.rows[0]).not.toBe(first.rows[0]); // new properties: recomputed
    const snapshot = readDatabase(doc);
    const x = cache.apply(snapshot, ctx);
    const y = cache.apply({ ...snapshot }, ctx);
    expect(y.rows[0]).toBe(x.rows[0]);
  });

  it('report cycles and errors without breaking other formulas', () => {
    const properties: Property[] = [
      prop('title', 'title', {}, 'Name'),
      prop('f1', 'formula', { expression: 'prop("F2") + 1' }, 'F1'),
      prop('f2', 'formula', { expression: 'prop("F1") + 1' }, 'F2'),
      prop('f3', 'formula', { expression: '1 +' }, 'F3'),
      prop('f4', 'formula', { expression: '40 + 2' }, 'F4'),
    ];
    const compiled = compileFormulas(properties);
    expect(compiled.byId.get('f1')?.error).toMatch(/Circular reference/);
    expect(compiled.byId.get('f2')?.error).toMatch(/Circular reference/);
    expect(compiled.byId.get('f3')?.error).toMatch(/end of formula/);
    expect(compiled.byId.get('f4')?.error).toBeNull();
    const snapshot = new FormulaCache().apply(
      {
        properties,
        views: [],
        rows: [makeRow('r', {})],
        meta: { hideEmptyProperties: false, subItems: null, dependencies: null },
      },
      ctx,
    );
    expect(snapshot.rows[0]!.values).toMatchObject({ f1: null, f3: null, f4: 42 });
    expect(checkFormula('prop("F4") + prop("Name")', properties, 'new').error).toBeNull();
    expect(
      checkFormula('prop("Self")', [...properties, prop('s', 'formula', {}, 'Self')], 's').error
        ?.message,
    ).toMatch(/itself/);
  });

  it('follow renamed properties', () => {
    expect(renameInFormula('prop("Price") * prop("Qty") + prop("Price")', 'Price', 'Cost')).toBe(
      'prop("Cost") * prop("Qty") + prop("Cost")',
    );
    const { doc, price, total } = setup();
    renameProperty(doc, price, 'Unit price');
    expect(readDatabase(doc).properties.find((p) => p.id === total)?.config.expression).toBe(
      'prop("Unit price") * prop("Qty")',
    );
    setPropertyConfig(doc, total, { expression: 'prop("Unit price") * 2' });
    expect(new FormulaCache().apply(readDatabase(doc), ctx).rows[0]!.values[total]).toBe(4);
  });

  it('turn dates into date cells', () => {
    const properties: Property[] = [
      prop('title', 'title', {}, 'Name'),
      prop('d', 'formula', { expression: 'dateAdd(parseDate("2026-10-04"), 1, "days")' }, 'D'),
      prop('b', 'formula', { expression: '1 > 0' }, 'B'),
    ];
    const snapshot = new FormulaCache().apply(
      {
        properties,
        views: [],
        rows: [makeRow('r', {})],
        meta: { hideEmptyProperties: false, subItems: null, dependencies: null },
      },
      ctx,
    );
    expect(snapshot.rows[0]!.values).toEqual({ d: { start: '2026-10-05' }, b: true });
    expect(snapshot.properties.map((p) => p.config.resultType)).toEqual([
      undefined,
      'date',
      'boolean',
    ]);
  });
});
