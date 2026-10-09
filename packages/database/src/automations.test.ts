import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addOption,
  addProperty,
  addRow,
  deleteAutomation,
  initDatabase,
  nextRun,
  planActions,
  readAutomations,
  readDatabase,
  setAutomation,
  setCell,
  trashRow,
  triggeredBy,
  type Automation,
} from './index';

const ctx = { users: new Map([['u-ada', 'Ada']]) };

function setup() {
  const doc = new Y.Doc();
  initDatabase(doc, { databaseId: 'db' });
  const status = addProperty(doc, { name: 'Status', type: 'select' });
  addOption(doc, status, { id: 'todo', name: 'To do', color: 'gray' });
  addOption(doc, status, { id: 'done', name: 'Done', color: 'green' });
  const completed = addProperty(doc, { name: 'Completed', type: 'date' });
  const owner = addProperty(doc, { name: 'Owner', type: 'person' });
  const points = addProperty(doc, { name: 'Points', type: 'number' });
  return { doc, status, completed, owner, points };
}

const automation = (over: Partial<Automation>): Automation => ({
  id: 'a1',
  name: 'Done → completed',
  enabled: true,
  trigger: { kind: 'pageAdded' },
  condition: null,
  actions: [],
  createdBy: 'u-ada',
  createdAt: 1,
  ...over,
});

/** The rows before and after `change`. */
function diff(doc: Y.Doc, change: () => void) {
  const before = readDatabase(doc).rows;
  change();
  const after = readDatabase(doc);
  return { before, after: after.rows, properties: after.properties };
}

describe('automations', () => {
  it('are stored in the database doc', () => {
    const { doc } = setup();
    setAutomation(doc, automation({ id: 'b', createdAt: 2 }));
    setAutomation(doc, automation({ id: 'a', createdAt: 1 }));
    expect(readAutomations(doc).map((a) => a.id)).toEqual(['a', 'b']);
    deleteAutomation(doc, 'a');
    expect(readAutomations(doc).map((a) => a.id)).toEqual(['b']);
  });

  it('a page added starts "page added" (not templates, not edits)', () => {
    const { doc } = setup();
    const a = automation({});
    const added = diff(doc, () => addRow(doc, { id: 'r1', actor: 'u-ada', title: 'Gear' }));
    expect(triggeredBy([a], added.before, added.after, added.properties, ctx)).toEqual([
      { automation: a, rowId: 'r1' },
    ]);
    const edited = diff(doc, () => setCell(doc, 'r1', TITLE_PROPERTY_ID, 'x', 'u-ada'));
    expect(triggeredBy([a], edited.before, edited.after, edited.properties, ctx)).toEqual([]);
    const disabled = automation({ enabled: false });
    const another = diff(doc, () => addRow(doc, { actor: 'u-ada', title: 'Bolt' }));
    expect(triggeredBy([disabled], another.before, another.after, another.properties, ctx)).toEqual(
      [],
    );
  });

  it('"set to" fires when a property becomes the value, once', () => {
    const { doc, status, points } = setup();
    addRow(doc, { id: 'r1', actor: 'u-ada', title: 'Gear' });
    const a = automation({ trigger: { kind: 'propertyEdited', propertyId: status, to: 'done' } });
    const any = automation({ id: 'a2', trigger: { kind: 'propertyEdited', propertyId: points } });
    const run = (change: () => void) => {
      const d = diff(doc, change);
      return triggeredBy([a, any], d.before, d.after, d.properties, ctx).map(
        (t) => t.automation.id,
      );
    };
    expect(run(() => setCell(doc, 'r1', status, 'todo', 'u-ada'))).toEqual([]);
    expect(run(() => setCell(doc, 'r1', status, 'done', 'u-ada'))).toEqual(['a1']);
    // Already done: setting it again (or another property) doesn't.
    expect(run(() => setCell(doc, 'r1', status, 'done', 'u-ada'))).toEqual([]);
    expect(run(() => setCell(doc, 'r1', points, 3, 'u-ada'))).toEqual(['a2']);
    // A trashed page starts nothing.
    expect(run(() => trashRow(doc, 'r1'))).toEqual([]);
  });

  it('conditions filter the pages', () => {
    const { doc, points } = setup();
    const a = automation({
      condition: {
        type: 'group',
        id: 'g',
        conjunction: 'and',
        filters: [{ type: 'rule', id: 'r', propertyId: points, operator: 'gt', value: 5 }],
      },
    });
    const small = diff(doc, () =>
      addRow(doc, { actor: 'u-ada', title: 'S', values: { [points]: 1 } }),
    );
    expect(triggeredBy([a], small.before, small.after, small.properties, ctx)).toEqual([]);
    const big = diff(doc, () =>
      addRow(doc, { actor: 'u-ada', title: 'B', values: { [points]: 9 } }),
    );
    expect(triggeredBy([a], big.before, big.after, big.properties, ctx)).toHaveLength(1);
  });

  it('plans actions with fixed, now, triggering person and copied values', () => {
    const { doc, status, completed, owner, points } = setup();
    addRow(doc, {
      id: 'r1',
      actor: 'u-ada',
      title: 'Gear',
      values: { [points]: 4, [owner]: ['u-bob'] },
    });
    const { rows, properties } = readDatabase(doc);
    const a = automation({
      actions: [
        {
          kind: 'setProperties',
          values: {
            [completed]: { kind: 'now' },
            [status]: { kind: 'fixed', value: 'done' },
            [owner]: { kind: 'triggeredBy' },
          },
        },
        {
          kind: 'addPage',
          title: 'Follow-up',
          values: { [points]: { kind: 'copy', propertyId: points } },
        },
        { kind: 'notify', people: ['u-ada'], peopleProperty: owner, message: 'Gear done' },
        { kind: 'webhook', url: 'https://hooks.lab.io/x', headers: { 'x-team': 'robots' } },
      ],
    });
    const now = Date.UTC(2026, 9, 9, 12);
    const effects = planActions(a, rows[0]!, properties, {
      databaseId: 'db',
      actorId: 'u-cy',
      now,
    });
    expect(effects[0]).toEqual({
      kind: 'edit',
      rowId: 'r1',
      values: { [completed]: { start: '2026-10-09' }, [status]: 'done', [owner]: ['u-cy'] },
    });
    expect(effects[1]).toEqual({ kind: 'add', title: 'Follow-up', values: { [points]: 4 } });
    expect(effects[2]).toEqual({
      kind: 'notify',
      userIds: ['u-ada', 'u-bob'],
      message: 'Gear done',
      rowId: 'r1',
    });
    expect(effects[3]).toMatchObject({
      kind: 'webhook',
      url: 'https://hooks.lab.io/x',
      body: {
        source: { type: 'automation', automationId: 'a1', databaseId: 'db' },
        data: { id: 'r1', title: 'Gear', properties: { Points: 4, Owner: ['u-bob'] } },
        triggeredAt: '2026-10-09T12:00:00.000Z',
      },
    });
    // A scheduled run has no page: no edits of it.
    expect(
      planActions(a, null, properties, { databaseId: 'db', actorId: null, now }).map((e) => e.kind),
    ).toEqual(['add', 'notify', 'webhook']);
  });

  it('schedules: daily, weekly and monthly, in their time zone, across DST', () => {
    const at = (iso: string) => Date.parse(iso);
    // Daily 09:00 in Berlin: 07:00 UTC in summer time, 08:00 UTC once the clocks go back
    // (on 25 October), and after 9:00 local it's the next day's.
    const berlin = { every: 'day', time: '09:00', timeZone: 'Europe/Berlin' } as const;
    expect(nextRun(berlin, at('2026-10-25T07:30:00Z'))).toBe(at('2026-10-25T08:00:00Z'));
    expect(nextRun(berlin, at('2026-10-25T08:30:00Z'))).toBe(at('2026-10-26T08:00:00Z'));
    expect(
      nextRun(
        { every: 'day', time: '09:00', timeZone: 'Europe/Berlin' },
        at('2026-10-24T06:00:00Z'),
      ),
    ).toBe(at('2026-10-24T07:00:00Z'));
    // Weekly on Mondays at 08:30 New York (2026-10-12 is a Monday).
    expect(
      nextRun(
        { every: 'week', time: '08:30', timeZone: 'America/New_York', weekday: 1 },
        at('2026-10-09T12:00:00Z'),
      ),
    ).toBe(at('2026-10-12T12:30:00Z'));
    // Monthly on the 31st: the last day of shorter months.
    expect(
      nextRun(
        { every: 'month', time: '00:00', timeZone: 'UTC', monthDay: 31 },
        at('2026-11-01T00:00:00Z'),
      ),
    ).toBe(at('2026-11-30T00:00:00Z'));
    expect(nextRun({ every: 'day', time: '25:00', timeZone: 'UTC' }, 0)).toBeNull();
    expect(nextRun({ every: 'day', time: '09:00', timeZone: 'Mars/Base' }, 0)).toBeNull();
  });
});
