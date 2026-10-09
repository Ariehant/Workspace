import {
  addOption,
  addProperty,
  addRow,
  initDatabase,
  readDatabase,
  setCell,
  type Property,
  type Row,
} from '@workspace/database';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  ApiError,
  compileFilter,
  compileSorts,
  listObject,
  parseId,
  parsePaging,
  parseSchema,
  parseValue,
  parseVersion,
  propertySchema,
  propertyValue,
  readRichText,
  richText,
  type ValueContext,
} from './index';

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const links: ValueContext = {
  fileUrl: (id) => ({ url: `https://files.test/${id}`, expiry_time: '2026-01-01T00:00:00.000Z' }),
};

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  const ids = {
    notes: addProperty(doc, { name: 'Notes', type: 'text' }),
    points: addProperty(doc, { name: 'Points', type: 'number' }),
    stage: addProperty(doc, { name: 'Stage', type: 'select' }),
    tags: addProperty(doc, { name: 'Labels', type: 'multiSelect' }),
    status: addProperty(doc, { name: 'Status', type: 'status' }),
    due: addProperty(doc, { name: 'Due', type: 'date' }),
    done: addProperty(doc, { name: 'Done', type: 'checkbox' }),
    link: addProperty(doc, { name: 'Link', type: 'url' }),
    mail: addProperty(doc, { name: 'Mail', type: 'email' }),
    phone: addProperty(doc, { name: 'Phone', type: 'phone' }),
    files: addProperty(doc, { name: 'Files', type: 'files' }),
    owner: addProperty(doc, { name: 'Owner', type: 'person' }),
    created: addProperty(doc, { name: 'Created', type: 'createdTime' }),
    by: addProperty(doc, { name: 'Created by', type: 'createdBy' }),
    uid: addProperty(doc, { name: 'ID', type: 'uniqueId' }),
    related: addProperty(doc, { name: 'Related', type: 'relation' }),
  };
  addOption(doc, ids.stage, { id: 'o-plan', name: 'Plan', color: 'blue' });
  addOption(doc, ids.stage, { id: 'o-build', name: 'Build', color: 'green' });
  addOption(doc, ids.tags, { id: 't-arm', name: 'arm', color: 'red' });
  addOption(doc, ids.tags, { id: 't-leg', name: 'leg', color: 'gray' });
  const props = () => readDatabase(doc).properties;
  const prop = (id: string) => props().find((p) => p.id === id)!;
  return { doc, ids, props, prop };
}

const rowOf = (doc: Y.Doc, id: string): Row => readDatabase(doc).rows.find((r) => r.id === id)!;

describe('ids and versions', () => {
  it('accepts dashed and compact ids', () => {
    expect(parseId('1111111111114111811111111111111A')).toBe(
      '11111111-1111-4111-8111-11111111111a',
    );
    expect(parseId(ADA)).toBe(ADA);
    expect(parseId('nope')).toBeNull();
  });
  it('maps Notion-Version to a shape', () => {
    expect(parseVersion('2022-06-28')).toBe('2022-06-28');
    expect(parseVersion('2025-09-03')).toBe('2025-09-03');
    expect(parseVersion('2026-01-15')).toBe('2025-09-03');
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('rich text', () => {
  it('splits long text into 2,000-character items, and reads text back', () => {
    const items = richText('x'.repeat(4500));
    expect(items.map((i) => i.text.content.length)).toEqual([2000, 2000, 500]);
    expect(readRichText(items, 'r')).toBe('x'.repeat(4500));
    expect(
      readRichText(
        [{ type: 'text', text: { content: 'Hi ' } }, { text: { content: 'there' } }],
        'r',
      ),
    ).toBe('Hi there');
    expect(() => readRichText('Hi', 'r')).toThrow(ApiError);
    expect(() =>
      readRichText([{ type: 'text', text: { content: 'x'.repeat(2001) } }], 'r'),
    ).toThrow(/≤ 2000/);
  });
});

describe('property values', () => {
  it('every stored type, both ways', () => {
    const { doc, ids, prop } = setup();
    const ctx = { isUser: (id: string) => id === ADA || id === BOB };
    const row = addRow(doc, { actor: ADA, title: 'Grease the gears', now: Date.UTC(2026, 9, 9) });
    const write = (id: string, input: unknown) => {
      const parsed = parseValue(prop(id), input, ctx);
      setCell(doc, row, id, parsed.value, ADA);
      return parsed;
    };
    write(ids.notes, { rich_text: richText('Oil first') });
    write(ids.points, { number: 3.5 });
    write(ids.stage, { select: { name: 'Build' } });
    write(ids.tags, { multi_select: [{ name: 'arm' }, { id: 't-leg' }] });
    write(ids.due, { date: { start: '2026-10-12', end: '2026-10-14' } });
    write(ids.done, { checkbox: true });
    write(ids.link, { url: 'https://lab.io' });
    write(ids.mail, { email: 'ada@lab.io' });
    write(ids.phone, { phone_number: '+44 20 7946 0000' });
    write(ids.files, {
      files: [{ name: 'spec.pdf', external: { url: 'https://lab.io/spec.pdf' } }],
    });
    write(ids.owner, { people: [{ id: BOB }] });
    write(ids.related, { relation: [{ id: BOB.replace(/-/g, '') }] });

    const r = rowOf(doc, row);
    const out = (id: string) => propertyValue(r, prop(id), links);
    expect(propertyValue(r, prop('title'), links)).toMatchObject({
      id: 'title',
      type: 'title',
      title: [{ plain_text: 'Grease the gears' }],
    });
    expect(out(ids.notes)).toMatchObject({
      type: 'rich_text',
      rich_text: [{ plain_text: 'Oil first' }],
    });
    expect(out(ids.points)).toMatchObject({ type: 'number', number: 3.5 });
    expect(out(ids.stage)).toMatchObject({
      select: { id: 'o-build', name: 'Build', color: 'green' },
    });
    expect(out(ids.tags)).toMatchObject({ multi_select: [{ name: 'arm' }, { name: 'leg' }] });
    expect(out(ids.due)).toMatchObject({
      date: { start: '2026-10-12', end: '2026-10-14', time_zone: null },
    });
    expect(out(ids.done)).toMatchObject({ checkbox: true });
    expect(out(ids.link)).toMatchObject({ url: 'https://lab.io' });
    expect(out(ids.mail)).toMatchObject({ email: 'ada@lab.io' });
    expect(out(ids.phone)).toMatchObject({
      type: 'phone_number',
      phone_number: '+44 20 7946 0000',
    });
    expect(out(ids.files)).toMatchObject({
      files: [{ name: 'spec.pdf', type: 'external', external: { url: 'https://lab.io/spec.pdf' } }],
    });
    expect(out(ids.owner)).toMatchObject({ people: [{ object: 'user', id: BOB }] });
    expect(out(ids.related)).toMatchObject({ relation: [{ id: BOB }], has_more: false });
    expect(out(ids.created)).toMatchObject({ created_time: '2026-10-09T00:00:00.000Z' });
    expect(out(ids.by)).toMatchObject({ created_by: { object: 'user', id: ADA } });
    expect(out(ids.uid)).toMatchObject({ unique_id: { prefix: null, number: 1 } });

    // Stored files come out with a link; times as UTC instants.
    setCell(doc, row, ids.files, [{ id: 'f1', name: 'photo.png' }], ADA);
    setCell(doc, row, ids.due, { start: '2026-10-12T09:30' }, ADA);
    const again = rowOf(doc, row);
    expect(propertyValue(again, prop(ids.files), links)).toMatchObject({
      files: [{ type: 'file', file: { url: 'https://files.test/f1' } }],
    });
    expect(propertyValue(again, prop(ids.due), links)).toMatchObject({
      date: { start: '2026-10-12T09:30:00.000+00:00' },
    });
  });

  it('a new select name makes an option; status and computed values are checked', () => {
    const { ids, prop } = setup();
    const ctx = { isUser: () => true };
    const made = parseValue(prop(ids.stage), { select: { name: 'Ship', color: 'purple' } }, ctx);
    expect(made.newOptions).toMatchObject([{ name: 'Ship', color: 'purple' }]);
    expect(made.value).toBe(made.newOptions![0]!.id);
    expect(() => parseValue(prop(ids.status), { status: { name: 'Shipped' } }, ctx)).toThrow(
      /isn't an option/,
    );
    expect(() => parseValue(prop(ids.created), { created_time: '2026-01-01' }, ctx)).toThrow(
      /computed/,
    );
    expect(() => parseValue(prop(ids.points), { number: '3' }, ctx)).toThrow(/number/);
    expect(() => parseValue(prop(ids.points), { rich_text: [] }, ctx)).toThrow(
      /number should be defined/,
    );
    expect(() => parseValue(prop(ids.mail), { email: 'not-an-email' }, ctx)).toThrow(ApiError);
    expect(() =>
      parseValue(prop(ids.owner), { people: [{ id: ADA }] }, { isUser: () => false }),
    ).toThrow(/user of the workspace/);
    expect(
      parseValue(prop(ids.due), { date: { start: '2026-10-12T09:30:00+02:00' } }, ctx).value,
    ).toEqual({
      start: '2026-10-12T07:30',
    });
  });
});

describe('schemas', () => {
  it('describes properties as Notion does', () => {
    const { ids, props, prop } = setup();
    expect(propertySchema(prop(ids.stage), props())).toMatchObject({
      name: 'Stage',
      type: 'select',
      select: { options: [{ id: 'o-plan', name: 'Plan', color: 'blue' }, { name: 'Build' }] },
    });
    expect(propertySchema(prop(ids.status), props())).toMatchObject({
      type: 'status',
      status: { groups: [{ id: 'todo' }, { id: 'inProgress' }, { id: 'complete' }] },
    });
    expect(propertySchema(prop(ids.points), props())).toMatchObject({
      number: { format: 'number' },
    });
    expect(propertySchema(prop(ids.phone), props())).toMatchObject({ type: 'phone_number' });
  });

  it('reads schemas sent in', () => {
    expect(parseSchema({ number: { format: 'dollar' } }, 'p')).toEqual({
      type: 'number',
      config: { numberFormat: 'dollar' },
    });
    expect(parseSchema({ select: { options: [{ name: 'A', color: 'red' }] } }, 'p')).toMatchObject({
      type: 'select',
      config: { options: [{ name: 'A', color: 'red' }] },
    });
    expect(parseSchema({ type: 'rich_text', rich_text: {} }, 'p')).toEqual({
      type: 'text',
      config: {},
    });
    expect(parseSchema({ formula: { expression: 'prop("Points") * 2' } }, 'p')).toEqual({
      type: 'formula',
      config: { expression: 'prop("Points") * 2' },
    });
    expect(() => parseSchema({ number: { format: 'bitcoin' } }, 'p')).toThrow(/isn't supported/);
    expect(() => parseSchema({ sparkle: {} }, 'p')).toThrow(/property type/);
  });
});

describe('filters', () => {
  function rows() {
    const s = setup();
    const { doc, ids } = s;
    const a = addRow(doc, { actor: ADA, title: 'Alpha arm', now: Date.UTC(2026, 9, 1) });
    const b = addRow(doc, { actor: BOB, title: 'Beta leg', now: Date.UTC(2026, 9, 5) });
    const c = addRow(doc, { actor: ADA, title: 'Gamma', now: Date.UTC(2026, 9, 8) });
    setCell(doc, a, ids.points, 5, ADA);
    setCell(doc, b, ids.points, 12, ADA);
    setCell(doc, a, ids.stage, 'o-plan', ADA);
    setCell(doc, b, ids.stage, 'o-build', ADA);
    setCell(doc, a, ids.tags, ['t-arm'], ADA);
    setCell(doc, b, ids.tags, ['t-arm', 't-leg'], ADA);
    setCell(doc, a, ids.done, true, ADA);
    setCell(doc, a, ids.due, { start: '2026-10-10' }, ADA);
    setCell(doc, b, ids.due, { start: '2026-10-20T15:00' }, ADA);
    setCell(doc, b, ids.owner, [BOB], ADA);
    return { ...s, a, b, c };
  }
  const run = (f: unknown) => {
    const r = rows();
    const test = compileFilter(f, r.props(), Date.UTC(2026, 9, 9, 12));
    const titles = readDatabase(r.doc)
      .rows.filter(test)
      .map((x) => x.title);
    return titles;
  };

  it('text', () => {
    expect(run({ property: 'Name', title: { contains: 'ALPHA' } })).toEqual(['Alpha arm']);
    expect(run({ property: 'title', rich_text: { starts_with: 'be' } })).toEqual(['Beta leg']);
    expect(run({ property: 'Name', title: { equals: 'Gamma' } })).toEqual(['Gamma']);
    expect(run({ property: 'Name', title: { does_not_contain: 'a' } })).toEqual([]);
    expect(run({ property: 'Notes', rich_text: { is_empty: true } })).toHaveLength(3);
  });

  it('numbers, checkboxes, selects, multi-selects and people', () => {
    expect(run({ property: 'Points', number: { greater_than: 6 } })).toEqual(['Beta leg']);
    expect(run({ property: 'Points', number: { less_than_or_equal_to: 5 } })).toEqual([
      'Alpha arm',
    ]);
    expect(run({ property: 'Points', number: { is_empty: true } })).toEqual(['Gamma']);
    expect(run({ property: 'Done', checkbox: { equals: false } })).toEqual(['Beta leg', 'Gamma']);
    expect(run({ property: 'Stage', select: { equals: 'Build' } })).toEqual(['Beta leg']);
    expect(run({ property: 'Stage', select: { does_not_equal: 'Build' } })).toEqual([
      'Alpha arm',
      'Gamma',
    ]);
    expect(run({ property: 'Labels', multi_select: { contains: 'leg' } })).toEqual(['Beta leg']);
    expect(run({ property: 'Labels', multi_select: { does_not_contain: 'arm' } })).toEqual([
      'Gamma',
    ]);
    expect(run({ property: 'Owner', people: { contains: BOB } })).toEqual(['Beta leg']);
    expect(run({ property: 'Created by', created_by: { contains: ADA } })).toEqual([
      'Alpha arm',
      'Gamma',
    ]);
  });

  it('dates and timestamps', () => {
    expect(run({ property: 'Due', date: { equals: '2026-10-10' } })).toEqual(['Alpha arm']);
    expect(run({ property: 'Due', date: { after: '2026-10-10' } })).toEqual(['Beta leg']);
    expect(run({ property: 'Due', date: { on_or_before: '2026-10-20T15:00:00Z' } })).toEqual([
      'Alpha arm',
      'Beta leg',
    ]);
    expect(run({ property: 'Due', date: { next_week: {} } })).toEqual(['Alpha arm']);
    expect(run({ property: 'Due', date: { is_empty: true } })).toEqual(['Gamma']);
    expect(run({ timestamp: 'created_time', created_time: { past_week: {} } })).toEqual([
      'Beta leg',
      'Gamma',
    ]);
  });

  it('compound filters, nested two deep', () => {
    expect(
      run({
        or: [
          { property: 'Done', checkbox: { equals: true } },
          {
            and: [
              { property: 'Points', number: { greater_than: 10 } },
              { property: 'Labels', multi_select: { contains: 'leg' } },
            ],
          },
        ],
      }),
    ).toEqual(['Alpha arm', 'Beta leg']);
    expect(() => run({ and: [{ or: [{ and: [] }] }] })).toThrow(/at most 2 levels/);
  });

  it('refuses what it can’t run', () => {
    expect(() => run({ property: 'Nope', number: { equals: 1 } })).toThrow(/no property/);
    expect(() => run({ property: 'Points', number: { roughly: 1 } })).toThrow(/number condition/);
    expect(() => run({ property: 'Points', select: { equals: 'x' } })).toThrow(/number property/);
    expect(() => run({ property: 'Due', date: { equals: 'soon' } })).toThrow(/ISO 8601/);
  });

  it('sorts, empty values last', () => {
    const r = rows();
    const props: Property[] = r.props();
    const sort = compileSorts([{ property: 'Points', direction: 'descending' }], props);
    expect(
      readDatabase(r.doc)
        .rows.sort(sort)
        .map((x) => x.title),
    ).toEqual(['Beta leg', 'Alpha arm', 'Gamma']);
    const byTime = compileSorts([{ timestamp: 'created_time', direction: 'descending' }], props);
    expect(
      readDatabase(r.doc)
        .rows.sort(byTime)
        .map((x) => x.title),
    ).toEqual(['Gamma', 'Beta leg', 'Alpha arm']);
    expect(() => compileSorts([{ property: 'Points', direction: 'up' }], props)).toThrow(
      /direction/,
    );
  });
});

describe('lists', () => {
  it('pages through with cursors', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((x) => ({ id: x }));
    const first = listObject(
      items,
      (i) => i.id,
      parsePaging({ page_size: 2 }),
      'page_or_database',
      (i) => i,
    );
    expect(first).toMatchObject({
      results: [{ id: 'a' }, { id: 'b' }],
      has_more: true,
      next_cursor: 'c',
    });
    const last = listObject(
      items,
      (i) => i.id,
      parsePaging({ page_size: 2, start_cursor: 'e' }),
      'x',
      (i) => i,
    );
    expect(last).toMatchObject({ results: [{ id: 'e' }], has_more: false, next_cursor: null });
    expect(() => parsePaging({ page_size: 101 })).toThrow(/1 to 100/);
    expect(() =>
      listObject(
        items,
        (i) => i.id,
        parsePaging({ start_cursor: 'zz' }),
        'x',
        (i) => i,
      ),
    ).toThrow(/cursor/);
  });
});
