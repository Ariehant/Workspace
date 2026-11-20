import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TITLE_PROPERTY_ID,
  addOption,
  addProperty,
  addRow,
  createRelation,
  deleteAutomation,
  initDatabase,
  isValidSchedule,
  nextRun,
  planActions,
  readAutomations,
  readDatabase,
  relatedDatabasesOf,
  scheduleKey,
  setAutomation,
  setCell,
  setRelation,
  trashRow,
  triggeredBy,
  type Automation,
  type Schedule,
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

  it('schedules on several weekdays (a repeating template)', () => {
    const at = (iso: string) => Date.parse(iso);
    // Mondays and Thursdays at 09:00 UTC; 2026-10-12 is a Monday.
    const s: Schedule = { every: 'week', time: '09:00', timeZone: 'UTC', weekdays: [1, 4] };
    expect(isValidSchedule(s)).toBe(true);
    expect(nextRun(s, at('2026-10-12T10:00:00Z'))).toBe(at('2026-10-15T09:00:00Z'));
    expect(nextRun(s, at('2026-10-15T10:00:00Z'))).toBe(at('2026-10-19T09:00:00Z'));
    expect(isValidSchedule({ every: 'week', time: '09:00', timeZone: 'UTC', weekdays: [] })).toBe(
      false,
    );
    expect(isValidSchedule({ every: 'week', time: '09:00', timeZone: 'UTC', weekdays: [7] })).toBe(
      false,
    );
    // A change of days is a different schedule (runs lined up for the old one are dropped).
    expect(scheduleKey(s)).not.toBe(scheduleKey({ ...s, weekdays: [1] }));
    expect(scheduleKey(s)).toBe(scheduleKey({ ...s, weekdays: [4, 1] }));
  });

  it('adds a page from a template', () => {
    const a: Automation = {
      id: 'a',
      name: 'Weekly review',
      enabled: true,
      trigger: { kind: 'schedule', schedule: { every: 'day', time: '09:00', timeZone: 'UTC' } },
      condition: null,
      actions: [{ kind: 'addPage', title: '', values: {}, templateId: 'tpl' }],
      createdBy: 'u1',
      createdAt: 0,
    };
    expect(planActions(a, null, [], { databaseId: 'db', actorId: null, now: 0 })).toEqual([
      { kind: 'add', title: '', values: {}, templateId: 'tpl' },
    ]);
  });

  it('a button pressed starts "button pressed" (each press; other edits don\'t)', () => {
    const { doc, points } = setup();
    const ship = addProperty(doc, { name: 'Ship it', type: 'button' });
    addRow(doc, { id: 'r1', actor: 'u-ada', title: 'Gear' });
    const a = automation({ trigger: { kind: 'buttonPressed', propertyId: ship } });
    const pressed = diff(doc, () => setCell(doc, 'r1', ship, { at: 10, by: 'u-ada' }, 'u-ada'));
    expect(triggeredBy([a], pressed.before, pressed.after, pressed.properties, ctx)).toEqual([
      { automation: a, rowId: 'r1' },
    ]);
    const again = diff(doc, () => setCell(doc, 'r1', ship, { at: 11, by: 'u-ada' }, 'u-ada'));
    expect(triggeredBy([a], again.before, again.after, again.properties, ctx)).toHaveLength(1);
    const edited = diff(doc, () => setCell(doc, 'r1', points, 3, 'u-ada'));
    expect(triggeredBy([a], edited.before, edited.after, edited.properties, ctx)).toEqual([]);
    // A page added with a press already in it isn't a press.
    const added = diff(doc, () =>
      addRow(doc, { actor: 'u-ada', title: 'Bolt', values: { [ship]: { at: 12, by: 'u-ada' } } }),
    );
    expect(triggeredBy([a], added.before, added.after, added.properties, ctx)).toEqual([]);
  });

  it("formula values: the page's properties, written as the property's type", () => {
    const { doc, status, completed, points } = setup();
    const note = addProperty(doc, { name: 'Note', type: 'text' });
    const done = addProperty(doc, { name: 'Big', type: 'checkbox' });
    addRow(doc, { id: 'r1', actor: 'u-ada', title: 'Gear', values: { [points]: 4 } });
    const snapshot = readDatabase(doc);
    const row = snapshot.rows.find((r) => r.id === 'r1')!;
    const a = automation({
      actions: [
        {
          kind: 'setProperties',
          values: {
            [points]: { kind: 'formula', expression: 'prop("Points") * 2' },
            [note]: { kind: 'formula', expression: 'prop("Name") + " ×" + prop("Points")' },
            [done]: { kind: 'formula', expression: 'prop("Points") > 3' },
            [status]: { kind: 'formula', expression: 'if(prop("Points") > 3, "Done", "To do")' },
            [completed]: { kind: 'formula', expression: 'dateAdd(now(), 1, "days")' },
            [TITLE_PROPERTY_ID]: { kind: 'formula', expression: 'upper(prop("Name"))' },
          },
        },
      ],
    });
    const now = Date.parse('2026-11-20T12:00:00Z');
    const [effect] = planActions(
      a,
      row,
      snapshot.properties,
      { databaseId: 'db', actorId: 'u-ada', now },
      { snapshot, ctx },
    );
    expect(effect).toEqual({
      kind: 'edit',
      rowId: 'r1',
      title: 'GEAR',
      values: {
        [points]: 8,
        [note]: 'Gear ×4',
        [done]: true,
        [status]: 'done',
        [completed]: { start: expect.stringMatching(/^2026-11-2[01]/) as unknown },
      },
    });
    // A broken formula, or an option the property doesn't have, writes nothing there.
    const bad = automation({
      actions: [
        {
          kind: 'setProperties',
          values: {
            [points]: { kind: 'formula', expression: 'prop("Nope") +' },
            [status]: { kind: 'formula', expression: '"Blocked"' },
          },
        },
      ],
    });
    expect(
      planActions(
        bad,
        row,
        snapshot.properties,
        { databaseId: 'db', actorId: null, now },
        { snapshot, ctx },
      ),
    ).toEqual([{ kind: 'edit', rowId: 'r1', values: { [points]: null, [status]: null } }]);
  });

  it('edits the pages linked in a relation, in the related database', () => {
    const tasks = new Y.Doc();
    initDatabase(tasks, { databaseId: 'tasks' });
    const projects = new Y.Doc();
    initDatabase(projects, { databaseId: 'projects' });
    const docs = new Map([
      ['tasks', tasks],
      ['projects', projects],
    ]);
    const resolve = (id: string) => docs.get(id);
    const state = addProperty(projects, { name: 'State', type: 'select' });
    addOption(projects, state, { id: 'active', name: 'Active', color: 'blue' });
    const touched = addProperty(projects, { name: 'Last task', type: 'text' });
    const p1 = addRow(projects, { actor: 'u-ada', title: 'Arm' });
    const p2 = addRow(projects, { actor: 'u-ada', title: 'Base' });
    const { propertyId: project } = createRelation(resolve, {
      databaseId: 'tasks',
      name: 'Project',
      targetId: 'projects',
    });
    const t1 = addRow(tasks, { actor: 'u-ada', title: 'Wire the servo' });
    setRelation(resolve, 'tasks', t1, project, [p1, p2], 'u-ada');
    const snapshot = readDatabase(tasks);
    const row = snapshot.rows.find((r) => r.id === t1)!;
    const a = automation({
      actions: [
        {
          kind: 'editRelated',
          relationId: project,
          values: {
            [state]: { kind: 'fixed', value: 'active' },
            [touched]: { kind: 'copy', propertyId: TITLE_PROPERTY_ID },
          },
        },
      ],
    });
    const run = { databaseId: 'tasks', actorId: 'u-ada', now: 0 };
    const propertiesOf = (id: string) =>
      docs.has(id) ? readDatabase(docs.get(id)!).properties : null;
    expect(planActions(a, row, snapshot.properties, run, { snapshot, ctx, propertiesOf })).toEqual([
      {
        kind: 'editRelated',
        databaseId: 'projects',
        rowIds: [p1, p2],
        values: { [state]: 'active', [touched]: 'Wire the servo' },
      },
    ]);
    expect(relatedDatabasesOf(a, snapshot.properties)).toEqual(['projects']);
    // The related database not there (or nothing linked): nothing to do.
    expect(planActions(a, row, snapshot.properties, run, { snapshot, ctx })).toEqual([]);
    const lone = readDatabase(tasks).rows.find((r) => r.id === t1)!;
    expect(
      planActions(a, { ...lone, values: {} }, snapshot.properties, run, { propertiesOf }),
    ).toEqual([]);
  });
});
